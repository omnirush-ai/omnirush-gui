// boxsh is the shell the engine runs its shell tool with when a project's
// box is on. The engine calls it like a shell (`bash -c <command>`); boxsh
// runs the command inside the project's box through boxd and streams the
// output back, with the exit code and signals of a local shell.
//
// Which box: OMNIRUSH_BOX_KEY names it (set on the engine by the CLI, or per
// call by the box plugin); the box's record is <OMNIRUSH_BOX_HOME>/boxes/<key>.json,
// written by the CLI or the desktop app. With no key, a record that is "off",
// or a call that is not `-c <command>`, boxsh runs the real shell instead.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"omnirush.ai/box/proto"
)

var version = "dev"

// Record is the box record the CLI/desktop writes (boxes/<key>.json).
type Record struct {
	V         int    `json:"v"`
	Key       string `json:"key"`
	Root      string `json:"root"`
	CRoot     string `json:"croot"`
	Container string `json:"container"`
	// Backend runs the box (docker, podman, bwrap, apple, wslc, wsl, ...).
	Backend string `json:"backend"`
	Runtime string `json:"runtime"`
	// RuntimeArgs come before the runtime's own (`-e docker` through wsl.exe).
	RuntimeArgs []string `json:"runtime_args"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Token     string `json:"token"`
	State     string `json:"state"`
	Error     string `json:"error"`
	UID       int    `json:"uid"`
	GID       int    `json:"gid"`
	Home      string `json:"home"`
	Shell     string `json:"shell"`
	PathPre   string `json:"path_prefix"`
	EnvFile   string `json:"env_file"`
	// Revive: the app that wrote the record restarts boxd when asked
	// (boxes/<key>.revive); Updated is when it last wrote the record (ms).
	Revive  bool  `json:"revive"`
	Updated int64 `json:"updated"`
}

func main() {
	args := os.Args[1:]
	if len(args) == 1 && args[0] == "--box-version" {
		fmt.Println(version)
		return
	}
	command, rest, login, ok := parseShellArgs(args)
	key := strings.TrimSpace(os.Getenv("OMNIRUSH_BOX_KEY"))
	if !ok || key == "" {
		native(args)
		return
	}
	rec, err := waitReady(key)
	if err != nil {
		fmt.Fprintf(os.Stderr, "omnirush sandbox: %v\n", err)
		os.Exit(125)
	}
	if rec == nil {
		native(args)
		return
	}
	cwd, _ := os.Getwd()
	if cyg, handled := cygpath(rec, command, rest); handled {
		fmt.Println(cyg)
		return
	}
	argv := []string{rec.shell()}
	if login {
		argv = append(argv, "-l")
	}
	argv = append(argv, "-c", command)
	argv = append(argv, rest...)
	req := proto.Request{Op: "exec", Token: rec.Token, Argv: argv, Cwd: mapPath(cwd, rec), Env: forwardEnv(os.Environ())}
	start := time.Now()
	code, timing, err := runRemote(rec, req)
	if err != nil && rec.Runtime == "" && rec.Backend != "" {
		// A backend with no `exec` of its own (bubblewrap, the WSL distro): boxd is the only
		// way in. A boxd that stopped (idle limit, crash, the distro restarted) is started
		// again by the app that owns the session, and the command runs then. Never on this
		// machine instead.
		if !isDialError(err) {
			fmt.Fprintf(os.Stderr, "omnirush sandbox: the connection to the sandbox failed (%v); %s\n", err, recoverHint)
			os.Exit(125)
		}
		again, why := revive(key, rec, err)
		if again == nil {
			if strings.Contains(why, "Restart OmniRush") {
				fmt.Fprintf(os.Stderr, "omnirush sandbox: %s\n", why)
			} else {
				fmt.Fprintf(os.Stderr, "omnirush sandbox: the sandbox stopped and was not restarted (%s); %s\n", why, recoverHint)
			}
			os.Exit(125)
		}
		rec = again
		req.Token = rec.Token
		code, timing, err = runRemote(rec, req)
		if err != nil {
			fmt.Fprintln(os.Stderr, retryFailed(err))
			os.Exit(125)
		}
	}
	if err != nil && !isDialError(err) {
		// The command reached boxd and may have run: never again (a second git commit, a second install).
		fmt.Fprintln(os.Stderr, retryFailed(err))
		os.Exit(125)
	}
	if err != nil {
		// boxd is not reachable (restarting, crashed): nothing started, so the runtime's exec runs it instead.
		code = runtimeExec(rec, req)
		timing.Fallback = true
	}
	timing.TotalMs = float64(time.Since(start).Microseconds()) / 1000
	timing.Code = code
	logTiming(timing)
	os.Exit(code)
}

// recoverHint: what the user can do when the sandbox cannot be reached.
const recoverHint = "restart OmniRush (installs are kept), `omnirush sandbox reset` for a fresh sandbox, or `omnirush sandbox off` to run this folder on this machine"

// isDialError: nothing reached boxd (no listener, refused, timed out): the
// command did not start, so running it again cannot run it twice.
func isDialError(err error) bool {
	var op *net.OpError
	return errors.As(err, &op) && op.Op == "dial"
}

// retryFailed: the line for a command that failed again after boxd was started again.
func retryFailed(err error) string {
	if isDialError(err) {
		return fmt.Sprintf("omnirush sandbox: the sandbox is not reachable after a restart (%v); %s", err, recoverHint)
	}
	return fmt.Sprintf("omnirush sandbox: the connection to the sandbox broke during the command (%v); %s", err, recoverHint)
}

func reviveFile(key string) string {
	return filepath.Join(boxHome(), "boxes", key+".revive")
}

// reviveWait: how long a command waits for the sandbox to be started again.
func reviveWait() time.Duration {
	if v, err := strconv.Atoi(os.Getenv("OMNIRUSH_BOX_REVIVE_WAIT_MS")); err == nil && v >= 0 {
		return time.Duration(v) * time.Millisecond
	}
	return 60 * time.Second
}

// revive asks the app that owns the session to start boxd again
// (boxes/<key>.revive) and waits for the record to say where it is now.
// Returns the new record, or nil and why not. A request nobody took within
// the wait (no app restarts this box) is not made again: later commands
// fail at once instead of each waiting.
func revive(key string, rec *Record, cause error) (*Record, string) {
	if !rec.Revive {
		return nil, fmt.Sprintf("%v", cause)
	}
	wait := reviveWait()
	file := reviveFile(key)
	if st, err := os.Stat(file); err == nil && time.Since(st.ModTime()) > wait {
		return nil, fmt.Sprintf("%v; no answer to the restart request", cause)
	}
	asked := time.Now()
	body, _ := json.Marshal(map[string]any{"at": asked.UnixMilli(), "port": rec.Port, "error": cause.Error()})
	if _, err := os.Stat(file); err != nil {
		tmp := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
		if os.WriteFile(tmp, body, 0o600) == nil {
			_ = os.Rename(tmp, file)
		}
	}
	fmt.Fprintln(os.Stderr, "omnirush sandbox: the sandbox stopped; starting it again...")
	deadline := asked.Add(wait)
	for time.Now().Before(deadline) {
		time.Sleep(150 * time.Millisecond)
		now, err := readRecord(key)
		if err != nil {
			continue
		}
		switch now.State {
		case "failed":
			msg := now.Error
			if msg == "" {
				msg = "it could not start"
			}
			return nil, msg
		case "off":
			return nil, "the sandbox was turned off for this session"
		case "ready":
			// Started again (a new port or a newer record), or boxd answered after all
			// (the app took the request and found it running).
			_, pending := os.Stat(file)
			if now.Port != rec.Port || now.Updated > rec.Updated || pending != nil {
				return now, ""
			}
		}
	}
	return nil, fmt.Sprintf("%v; it did not start again in %v", cause, wait.Round(time.Second))
}

func (r *Record) shell() string {
	if r.Shell != "" {
		return r.Shell
	}
	return "/bin/bash"
}

// parseShellArgs reads a shell invocation: [-l] -c <command> [arg0 args...]
// (also -lc / -cl). ok is false for anything else (an interactive shell).
func parseShellArgs(args []string) (command string, rest []string, login bool, ok bool) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-l" || a == "--login":
			login = true
		case a == "-c" || a == "-lc" || a == "-cl":
			if a != "-c" {
				login = true
			}
			if i+1 >= len(args) {
				return "", nil, login, false
			}
			return args[i+1], args[i+2:], login, true
		case strings.HasPrefix(a, "-") && len(a) > 1 && !strings.HasPrefix(a, "--"):
			// combined short flags like -ec: keep the shell's own behaviour natively
			if strings.Contains(a, "c") {
				return "", nil, login, false
			}
		default:
			return "", nil, login, false
		}
	}
	return "", nil, login, false
}

func boxHome() string {
	if v := os.Getenv("OMNIRUSH_BOX_HOME"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".omnirush", "box")
}

func readRecord(key string) (*Record, error) {
	for _, c := range key {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return nil, errors.New("bad box key")
		}
	}
	data, err := os.ReadFile(filepath.Join(boxHome(), "boxes", key+".json"))
	if err != nil {
		return nil, err
	}
	var rec Record
	if err := json.Unmarshal(data, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// waitReady returns the ready record, nil for "run natively" (off), or an
// error the agent sees (failed, or never ready in time).
func waitReady(key string) (*Record, error) {
	limit := 180 * time.Second
	if v, err := strconv.Atoi(os.Getenv("OMNIRUSH_BOX_WAIT_MS")); err == nil && v >= 0 {
		limit = time.Duration(v) * time.Millisecond
	}
	start := time.Now()
	said := ""
	// While the image downloads (a first --sandbox run) the wait has no short
	// limit: the download has its own (an hour), and the command runs once it is in.
	pulled := time.Duration(0)
	last := time.Now()
	for {
		rec, err := readRecord(key)
		if err == nil && rec.State == "pulling" {
			pulled += time.Since(last)
		}
		last = time.Now()
		if err == nil {
			switch rec.State {
			case "ready":
				return rec, nil
			case "off":
				return nil, nil
			case "failed":
				msg := rec.Error
				if msg == "" {
					msg = "it could not start"
				}
				if strings.Contains(msg, "Restart OmniRush") {
					return nil, errors.New(msg) // says what to do already
				}
				return nil, fmt.Errorf("the sandbox is not available (%s); run `omnirush sandbox status`", msg)
			}
		}
		if time.Since(start)-pulled > limit || pulled > 61*time.Minute {
			if err != nil {
				return nil, fmt.Errorf("no sandbox record for this project (%v)", err)
			}
			return nil, errors.New("the sandbox did not start in time; run `omnirush sandbox status`")
		}
		if time.Since(start) > 1500*time.Millisecond {
			msg := "omnirush: waiting for the sandbox to start..."
			if err == nil && rec.State == "pulling" {
				msg = "omnirush: waiting for the sandbox image to download (once)..."
			}
			if msg != said {
				fmt.Fprintln(os.Stderr, msg)
				said = msg
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// mapPath maps a host path to the box: the project folder to its place
// inside; on Windows anything else to the project folder.
func mapPath(p string, rec *Record) string {
	if p == "" {
		return rec.CRoot
	}
	root, croot := rec.Root, rec.CRoot
	if runtime.GOOS == "windows" {
		lp, lr := strings.ToLower(filepath.Clean(p)), strings.ToLower(filepath.Clean(root))
		if lp == lr {
			return croot
		}
		if strings.HasPrefix(lp, lr+`\`) {
			rel := filepath.ToSlash(p[len(filepath.Clean(root))+1:])
			return strings.TrimSuffix(croot, "/") + "/" + rel
		}
		return croot
	}
	if root == croot {
		return p
	}
	if p == root {
		return croot
	}
	if strings.HasPrefix(p, strings.TrimSuffix(root, "/")+"/") {
		return strings.TrimSuffix(croot, "/") + p[len(strings.TrimSuffix(root, "/")):]
	}
	return p
}

// windowsToBox: C:\x\y -> /c/x/y (how the launcher mounts a Windows folder in the box).
func windowsToBox(p string) string {
	if len(p) >= 2 && p[1] == ':' {
		rest := strings.ReplaceAll(p[2:], `\`, "/")
		return "/" + strings.ToLower(p[:1]) + "/" + strings.TrimPrefix(rest, "/")
	}
	return strings.ReplaceAll(p, `\`, "/")
}

// unmapPath maps a path inside the box back to the host (Windows cygpath).
func unmapPath(p string, rec *Record) string {
	croot := strings.TrimSuffix(rec.CRoot, "/")
	if p == croot {
		return rec.Root
	}
	if strings.HasPrefix(p, croot+"/") {
		rel := p[len(croot)+1:]
		if runtime.GOOS == "windows" {
			rel = strings.ReplaceAll(rel, "/", `\`)
		}
		return filepath.Join(rec.Root, rel)
	}
	return p
}

// cygpath answers the engine's Windows path probe (`cygpath -w -- "$1"`) for
// paths in the box, without a round trip.
func cygpath(rec *Record, command string, rest []string) (string, bool) {
	if runtime.GOOS != "windows" || !strings.HasPrefix(strings.TrimSpace(command), "cygpath -w") || len(rest) < 2 {
		return "", false
	}
	return unmapPath(rest[1], rec), true
}

var passExact = map[string]bool{
	"TERM": true, "COLORTERM": true, "NO_COLOR": true, "FORCE_COLOR": true, "CLICOLOR": true, "CLICOLOR_FORCE": true,
	"TZ": true, "CI": true, "HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true, "http_proxy": true,
	"https_proxy": true, "no_proxy": true, "OMNIRUSH_TURN": true, "OMNIRUSH_CALL": true, "OMNIRUSH_SESSION": true,
	"OMNIRUSH_LEDGER_OFF": true, "OMNIRUSH_PKGLOG_DIR": true, "PAGER": true, "GIT_PAGER": true, "GIT_TERMINAL_PROMPT": true, "DEBIAN_FRONTEND": true,
}

// forwardEnv keeps only what describes the terminal and the turn: the host's
// environment (tokens, keys, PATH, HOME) never enters the box.
func forwardEnv(environ []string) map[string]string {
	extra := map[string]bool{}
	for _, name := range strings.Split(os.Getenv("OMNIRUSH_BOX_PASS_ENV"), ",") {
		if name = strings.TrimSpace(name); name != "" {
			extra[name] = true
		}
	}
	out := map[string]string{}
	for _, kv := range environ {
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			continue
		}
		k, v := kv[:i], kv[i+1:]
		// An empty TZ or a file (TZ=:/etc/localtime reads the box's own file) is left to the env file's zone name.
		if k == "TZ" && (v == "" || strings.HasPrefix(strings.TrimPrefix(v, ":"), "/")) {
			continue
		}
		if passExact[k] || extra[k] {
			if k == "OMNIRUSH_PKGLOG_DIR" && runtime.GOOS == "windows" {
				v = windowsToBox(v)
			}
			out[k] = v
		}
	}
	return out
}

// Timing is one call's overhead record (OMNIRUSH_BOX_TIMING_LOG).
type Timing struct {
	T         int64   `json:"t"`
	ConnectMs float64 `json:"connect_ms"`
	FirstMs   float64 `json:"first_byte_ms,omitempty"`
	DaemonMs  float64 `json:"daemon_ms"`
	WaitedMs  float64 `json:"waited_ms,omitempty"`
	TotalMs   float64 `json:"total_ms"`
	Code      int     `json:"code"`
	Fallback  bool    `json:"fallback,omitempty"`
}

func logTiming(t Timing) {
	file := os.Getenv("OMNIRUSH_BOX_TIMING_LOG")
	if file == "" {
		return
	}
	t.T = time.Now().UnixMilli()
	line, _ := json.Marshal(t)
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(line, '\n'))
}

func runRemote(rec *Record, req proto.Request) (int, Timing, error) {
	var timing Timing
	host := rec.Host
	if host == "" {
		host = "127.0.0.1"
	}
	start := time.Now()
	raw, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(rec.Port)), 3*time.Second)
	if err != nil {
		return 0, timing, err
	}
	defer raw.Close()
	if tcp, ok := raw.(*net.TCPConn); ok {
		_ = tcp.SetNoDelay(true)
	}
	timing.ConnectMs = float64(time.Since(start).Microseconds()) / 1000
	var wmu sync.Mutex
	send := func(kind byte, payload []byte) {
		wmu.Lock()
		defer wmu.Unlock()
		_ = proto.WriteFrame(raw, kind, payload)
	}
	wmu.Lock()
	err = proto.WriteRequest(raw, req)
	wmu.Unlock()
	if err != nil {
		return 0, timing, err
	}

	// Signals go to the command's process group in the box.
	sigs := make(chan os.Signal, 4)
	notifySignals(sigs)
	go func() {
		for s := range sigs {
			send(proto.Signal, []byte(signalName(s)))
		}
	}()
	// stdin: forwarded until EOF (the engine gives /dev/null: EOF at once).
	go func() {
		buf := make([]byte, 32<<10)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				send(proto.Stdin, buf[:n])
			}
			if err != nil {
				send(proto.StdinEOF, nil)
				return
			}
		}
	}()

	r := bufio.NewReaderSize(raw, 64<<10)
	out := bufio.NewWriterSize(os.Stdout, 32<<10)
	defer out.Flush()
	buf := make([]byte, 0, 64<<10)
	got := false
	for {
		kind, payload, err := proto.ReadFrame(r, buf)
		if err != nil {
			if !got {
				return 0, timing, err
			}
			out.Flush()
			fmt.Fprintln(os.Stderr, "omnirush sandbox: the connection to the sandbox was lost")
			return 125, timing, nil
		}
		if !got {
			got = true
			timing.FirstMs = float64(time.Since(start).Microseconds()) / 1000
		}
		switch kind {
		case proto.Stdout:
			_, _ = out.Write(payload)
			if r.Buffered() == 0 {
				out.Flush()
			}
		case proto.Stderr:
			out.Flush()
			_, _ = os.Stderr.Write(payload)
		case proto.Fail:
			out.Flush()
			fmt.Fprintf(os.Stderr, "omnirush sandbox: %s\n", payload)
		case proto.Exit:
			var info proto.ExitInfo
			_ = json.Unmarshal(payload, &info)
			timing.DaemonMs = info.Ms
			timing.WaitedMs = info.WaitedMs
			return info.Code, timing, nil
		}
	}
}

// runtimeExec runs the command with `docker|podman exec` (no boxd).
func runtimeExec(rec *Record, req proto.Request) int {
	bin := rec.Runtime
	if bin == "" {
		bin = "docker"
	}
	args := append(append([]string(nil), rec.RuntimeArgs...), "exec", "-i", "-w", req.Cwd)
	if rec.UID != 0 {
		args = append(args, "-u", fmt.Sprintf("%d:%d", rec.UID, rec.GID))
	}
	home := rec.Home
	if home == "" {
		home = "/root"
	}
	args = append(args, "-e", "HOME="+home)
	for k, v := range req.Env {
		args = append(args, "-e", k+"="+v)
	}
	args = append(args, rec.Container)
	argv := append([]string(nil), req.Argv...)
	if rec.PathPre != "" {
		// keep the package-manager wrappers in front, as boxd does
		for i := 0; i+1 < len(argv); i++ {
			if argv[i] == "-c" {
				argv[i+1] = "export PATH=" + rec.PathPre + ":\"$PATH\"; " + argv[i+1]
				break
			}
		}
	}
	args = append(args, argv...)
	cmd := exec.Command(bin, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode()
		}
		fmt.Fprintf(os.Stderr, "omnirush sandbox: the sandbox is not reachable: %v\n", err)
		return 125
	}
	return 0
}

// native runs the real shell with the same arguments.
func native(args []string) {
	shell := realShell()
	if runtime.GOOS != "windows" {
		err := syscall.Exec(shell, append([]string{shell}, args...), os.Environ())
		fmt.Fprintf(os.Stderr, "omnirush: could not run %s: %v\n", shell, err)
		os.Exit(127)
	}
	cmd := exec.Command(shell, windowsArgs(shell, args)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			os.Exit(ee.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "omnirush: could not run %s: %v\n", shell, err)
		os.Exit(127)
	}
	os.Exit(0)
}

// windowsArgs: cmd.exe takes /c, the others (Git Bash, pwsh, powershell) take -c.
func windowsArgs(shell string, args []string) []string {
	base := shell[strings.LastIndexAny(shell, `\/`)+1:]
	if strings.EqualFold(base, "cmd.exe") || strings.EqualFold(base, "cmd") {
		out := append([]string(nil), args...)
		for i, a := range out {
			if a == "-c" || a == "-lc" {
				out[i] = "/c"
			}
		}
		return out
	}
	return args
}

func realShell() string {
	if v := os.Getenv("OMNIRUSH_BOX_REAL_SHELL"); v != "" {
		return v
	}
	self, _ := os.Executable()
	selfDir := filepath.Dir(self)
	find := func(name string) string {
		for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
			if dir == "" || filepath.Clean(dir) == filepath.Clean(selfDir) {
				continue
			}
			cand := filepath.Join(dir, name)
			if st, err := os.Stat(cand); err == nil && !st.IsDir() {
				return cand
			}
		}
		return ""
	}
	if runtime.GOOS != "windows" {
		for _, name := range []string{"bash", "sh"} {
			if p := find(name); p != "" {
				return p
			}
		}
		return "/bin/sh"
	}
	// The engine's own order on Windows: Git Bash (next to git.exe), then
	// PowerShell, then cmd. Never System32\bash.exe: that is the WSL launcher.
	if git := find("git.exe"); git != "" {
		gitBash := filepath.Join(filepath.Dir(git), "..", "bin", "bash.exe")
		if st, err := os.Stat(gitBash); err == nil && !st.IsDir() {
			return filepath.Clean(gitBash)
		}
	}
	for _, name := range []string{"pwsh.exe", "powershell.exe"} {
		if p := find(name); p != "" {
			return p
		}
	}
	if sys := os.Getenv("ComSpec"); sys != "" {
		return sys
	}
	return "cmd.exe"
}
