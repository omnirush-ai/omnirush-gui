package main

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestParseShellArgs(t *testing.T) {
	cases := []struct {
		in    []string
		cmd   string
		rest  []string
		login bool
		ok    bool
	}{
		{[]string{"-c", "ls -la"}, "ls -la", []string{}, false, true},
		{[]string{"-lc", "cygpath -w -- \"$1\"", "_", "/x"}, "cygpath -w -- \"$1\"", []string{"_", "/x"}, true, true},
		{[]string{"-l", "-c", "echo hi"}, "echo hi", []string{}, true, true},
		{[]string{}, "", nil, false, false},
		{[]string{"script.sh"}, "", nil, false, false},
		{[]string{"-c"}, "", nil, false, false},
		{[]string{"-ec", "x"}, "", nil, false, false},
	}
	for _, c := range cases {
		cmd, rest, login, ok := parseShellArgs(c.in)
		if ok != c.ok || cmd != c.cmd || login != c.login || (c.ok && !reflect.DeepEqual(rest, c.rest)) {
			t.Errorf("%v: got %q %v %v %v", c.in, cmd, rest, login, ok)
		}
	}
}

func TestMapPathSame(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip()
	}
	rec := &Record{Root: "/home/u/proj", CRoot: "/home/u/proj"}
	if got := mapPath("/home/u/proj/src", rec); got != "/home/u/proj/src" {
		t.Fatal(got)
	}
	rec = &Record{Root: "/home/u/proj", CRoot: "/app"}
	for in, want := range map[string]string{"/home/u/proj": "/app", "/home/u/proj/a/b": "/app/a/b", "/home/u/projx": "/home/u/projx", "/tmp": "/tmp", "": "/app"} {
		if got := mapPath(in, rec); got != want {
			t.Errorf("%q -> %q want %q", in, got, want)
		}
	}
	if got := unmapPath("/app/a/b", rec); got != "/home/u/proj/a/b" {
		t.Fatal(got)
	}
}

func TestForwardEnv(t *testing.T) {
	t.Setenv("OMNIRUSH_BOX_PASS_ENV", "MY_FLAG")
	got := forwardEnv([]string{"TERM=xterm", "OMNIRUSH_ACCESS_TOKEN=secret", "OPENAI_API_KEY=k", "PATH=/x", "HOME=/h", "OMNIRUSH_TURN=3", "MY_FLAG=1", "AWS_SECRET_ACCESS_KEY=s"})
	want := map[string]string{"TERM": "xterm", "OMNIRUSH_TURN": "3", "MY_FLAG": "1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
	// TZ: a zone passes; empty or a file is left to the env file.
	if got := forwardEnv([]string{"TZ=Asia/Kolkata"}); got["TZ"] != "Asia/Kolkata" {
		t.Fatalf("%v", got)
	}
	for _, tz := range []string{"TZ=", "TZ=:/etc/localtime", "TZ=/usr/share/zoneinfo/Asia/Kolkata"} {
		if got := forwardEnv([]string{tz}); len(got) != 0 {
			t.Fatalf("%s: %v", tz, got)
		}
	}
}

func TestWindowsArgs(t *testing.T) {
	if got := windowsArgs(`C:\Windows\System32\cmd.exe`, []string{"-c", "dir"}); !reflect.DeepEqual(got, []string{"/c", "dir"}) {
		t.Fatal(got)
	}
	if got := windowsArgs(`C:\Program Files\Git\bin\bash.exe`, []string{"-c", "ls"}); !reflect.DeepEqual(got, []string{"-c", "ls"}) {
		t.Fatal(got)
	}
}

func TestWindowsToBox(t *testing.T) {
	if got := windowsToBox(`C:\Users\Sam\.omnirush\pkglog\raw\12-ab`); got != "/c/Users/Sam/.omnirush/pkglog/raw/12-ab" {
		t.Fatal(got)
	}
}

// A box whose image is downloading is waited for past the start limit; the limit counts once it starts.
func TestWaitReadyThroughDownload(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OMNIRUSH_BOX_HOME", home)
	t.Setenv("OMNIRUSH_BOX_WAIT_MS", "300")
	if err := os.MkdirAll(filepath.Join(home, "boxes"), 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(state string) {
		data := `{"v":1,"key":"abc123","root":"/p","croot":"/p","state":"` + state + `","port":1,"token":"t"}`
		if err := os.WriteFile(filepath.Join(home, "boxes", "abc123.json"), []byte(data), 0o600); err != nil {
			t.Error(err)
		}
	}
	write("pulling")
	go func() {
		time.Sleep(700 * time.Millisecond)
		write("ready")
	}()
	rec, err := waitReady("abc123")
	if err != nil || rec == nil || rec.State != "ready" {
		t.Fatalf("waited through the download: %v %+v", err, rec)
	}
	write("starting")
	if _, err := waitReady("abc123"); err == nil || !strings.Contains(err.Error(), "did not start in time") {
		t.Fatalf("a start that hangs still times out: %v", err)
	}
}

func writeRec(t *testing.T, home, key string, rec map[string]any) {
	t.Helper()
	data, _ := json.Marshal(rec)
	if err := os.MkdirAll(filepath.Join(home, "boxes"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "boxes", key+".json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReviveAsksAndWaitsForTheNewRecord(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OMNIRUSH_BOX_HOME", home)
	t.Setenv("OMNIRUSH_BOX_REVIVE_WAIT_MS", "3000")
	writeRec(t, home, "k1", map[string]any{"state": "ready", "port": 44897, "updated": 100, "revive": true, "backend": "bwrap", "token": "t1"})
	rec, _ := readRecord("k1")
	go func() {
		// The session sees the request, starts boxd again and writes where it is.
		for i := 0; i < 100; i++ {
			if _, err := os.Stat(reviveFile("k1")); err == nil {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		writeRec(t, home, "k1", map[string]any{"state": "ready", "port": 45001, "updated": 200, "revive": true, "backend": "bwrap", "token": "t2"})
		_ = os.Remove(reviveFile("k1"))
	}()
	again, why := revive("k1", rec, errors.New("dial tcp 127.0.0.1:44897: connect: connection refused"))
	if again == nil || again.Port != 45001 || again.Token != "t2" {
		t.Fatalf("got %+v (%s)", again, why)
	}
}

func TestReviveFailsWithTheSessionsReason(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OMNIRUSH_BOX_HOME", home)
	t.Setenv("OMNIRUSH_BOX_REVIVE_WAIT_MS", "3000")
	writeRec(t, home, "k1", map[string]any{"state": "ready", "port": 44897, "updated": 100, "revive": true, "backend": "bwrap"})
	rec, _ := readRecord("k1")
	go func() {
		time.Sleep(100 * time.Millisecond)
		writeRec(t, home, "k1", map[string]any{"state": "failed", "error": "the sandbox stopped and could not start again (x). Restart OmniRush (installs are kept), or `omnirush sandbox off`", "revive": true, "backend": "bwrap"})
	}()
	again, why := revive("k1", rec, errors.New("refused"))
	if again != nil || !strings.Contains(why, "omnirush sandbox off") {
		t.Fatalf("got %+v %q", again, why)
	}
}

func TestReviveOnlyWhenTheAppRestartsAndNotTwice(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OMNIRUSH_BOX_HOME", home)
	t.Setenv("OMNIRUSH_BOX_REVIVE_WAIT_MS", "200")
	// An app that does not restart boxd (no "revive"): no request, no wait.
	writeRec(t, home, "k1", map[string]any{"state": "ready", "port": 44897, "backend": "bwrap"})
	rec, _ := readRecord("k1")
	start := time.Now()
	if again, _ := revive("k1", rec, errors.New("refused")); again != nil || time.Since(start) > 100*time.Millisecond {
		t.Fatal("waited for an app that does not restart")
	}
	if _, err := os.Stat(reviveFile("k1")); err == nil {
		t.Fatal("asked an app that does not restart")
	}
	// Nobody answers: the first call waits once; a later one (request older than the wait) fails at once.
	writeRec(t, home, "k1", map[string]any{"state": "ready", "port": 44897, "revive": true, "backend": "bwrap"})
	rec, _ = readRecord("k1")
	if again, why := revive("k1", rec, errors.New("refused")); again != nil || !strings.Contains(why, "did not start again") {
		t.Fatalf("got %+v %q", again, why)
	}
	time.Sleep(50 * time.Millisecond)
	start = time.Now()
	if again, why := revive("k1", rec, errors.New("refused")); again != nil || !strings.Contains(why, "no answer") || time.Since(start) > 100*time.Millisecond {
		t.Fatalf("waited again: %q", why)
	}
}

func TestIsDialError(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	_, err = net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second)
	if err == nil || !isDialError(err) {
		t.Fatalf("refused dial: %v", err)
	}
	if isDialError(errors.New("EOF")) {
		t.Fatal("a read error is not a dial error")
	}
}

func TestRetryFailedSaysWhatBroke(t *testing.T) {
	dial := &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connect: connection refused")}
	if got := retryFailed(dial); !strings.Contains(got, "not reachable after a restart") {
		t.Fatal(got)
	}
	for _, err := range []error{errors.New("EOF"), &net.OpError{Op: "read", Net: "tcp", Err: errors.New("connection reset by peer")}} {
		got := retryFailed(err)
		if !strings.Contains(got, "broke during the command") || strings.Contains(got, "not reachable") {
			t.Fatal(got)
		}
	}
}

// A command that reached boxd may have run: only a failed dial (nothing started) may run it another way.
func TestOnlyADialFailureRunsTheCommandAnotherWay(t *testing.T) {
	if !isDialError(&net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connect: connection refused")}) {
		t.Fatal("a refused dial started nothing")
	}
	for _, err := range []error{errors.New("EOF"), &net.OpError{Op: "read", Net: "tcp", Err: errors.New("connection reset by peer")}, &net.OpError{Op: "write", Net: "tcp", Err: errors.New("broken pipe")}} {
		if isDialError(err) {
			t.Fatalf("%v came after the command started", err)
		}
	}
}
