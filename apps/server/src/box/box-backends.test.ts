// Ported from the CLI (omnirush-cli test/box-backends.test.js,
// feat/local-box-backends): the ranked choice per OS and each backend against
// its real CLI's output, mocked (no runtime on the test machine is touched):
// bubblewrap (boxrun's JSON), Apple `container` (1.x JSON), the OmniRush WSL
// distro (wsl.exe's UTF-16 output), WSL containers (wslc 3.0.1 JSON), and the
// overrides (the backend setting, the server's allowlist). Desktop additions:
// the service's status and setting, files-used through a non-container box.
import { afterEach, describe, expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { OPT_IN, BACKENDS, REQUIRED_FIRST, backendsFor, detectBackend, driverFor, normalizeBackend, ORDER } from "./backends/index.js";
import { apparmorProfile, boxEgress, boxdEnv, boxrunPath, bwrapCandidates, ENABLED_BWRAP, explainProbe, parseOut, probeBwrap, upArgs } from "./backends/bwrap.js";
import { appleInstallLogMounts, createAppleArgs, findDigest, macosMajor, parseVersions, probeApple, snapshotInfo, SUPPORTED as APPLE, systemProductVersion } from "./backends/apple.js";
import { versionAtLeast } from "./backends/shared.js";
import { decodeWsl, download, ENABLE_HINT, inDistro, parseWslList, probeWslDistro, startKeeper } from "./backends/wsl.js";
import { createWslcArgs, labelsOf, wslcInstallLogMounts, parseJsonRows, parseWslcVersion, probeWslc, UPDATE_HINT } from "./backends/wslc.js";
import { Box, setToolsRoot } from "./box.js";
import { installLogLayout } from "./common.js";
import { askedBackend, readBackend, rememberServerDefault, saveBackend, serverBackends } from "./launch.js";
import type { RunCommand, RunResult } from "./run.js";
import { BoxService, backendChoices, type BoxWorkspace } from "./service.js";
import { sandboxFilesUsed } from "../session-archive/files-used-sandbox.js";

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "box-be-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  setToolsRoot(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const set = (...files: Array<string | null>) => (file: string) => files.includes(file);

/** The install log as a box gets it (install-log.ts boxInstallLogPaths). */
const PKGLOG = {
  root: "/h/.omnirush/pkglog",
  tools: "/h/.omnirush/pkglog-wrappers",
  raw: "/h/.omnirush/pkglog/raw",
  bin: "/h/.omnirush/pkglog-wrappers/bin-0123456789ab",
  py: "/h/.omnirush/pkglog-wrappers/py-0123456789ab",
  legacy: { bin: "/h/.omnirush/pkglog/bin-0123456789ab", py: "/h/.omnirush/pkglog/py-0123456789ab" },
};
const ok = (stdout: unknown): RunResult => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: "", stderr });

/** A helpers folder with linux boxrun and boxd (empty stand-ins): the desktop finds helpers only where they are. */
function helperBin(): string {
  const dir = tmp();
  for (const arch of ["amd64", "arm64"]) {
    mkdirSync(path.join(dir, `linux-${arch}`), { recursive: true });
    for (const name of ["boxrun", "boxd"]) writeFileSync(path.join(dir, `linux-${arch}`, name), "");
  }
  return dir;
}

// --- ranking and overrides ---------------------------------------------------------------

describe("box backends: ranking and overrides", () => {
  test("the ranked order per OS", () => {
    expect(ORDER.linux).toEqual(["bwrap", "podman", "docker"]);
    expect(ORDER.darwin).toEqual(["orbstack", "colima", "docker-desktop", "rancher", "podman", "docker"]);
    expect(REQUIRED_FIRST.darwin).toEqual(["lima"]);
    expect(OPT_IN.darwin).toEqual(["apple"]);
    expect(ORDER.win32).toEqual(["wslc", "wsl", "docker-desktop", "podman", "docker", "wsl-engine"]);
    for (const list of Object.values(ORDER)) for (const id of list) expect(BACKENDS.some((b) => b === id)).toBe(true);
    expect(backendsFor("linux")).toEqual(ORDER.linux);
    expect(backendChoices("win32").map((c) => c.id)).toEqual(["auto", ...ORDER.win32, "native"]);
    expect(backendChoices("darwin").map((c) => c.id)).toEqual(["auto", "lima", ...ORDER.darwin, "apple", "native"]);
    expect(backendChoices("darwin").find((c) => c.id === "apple")?.label).toBe("Apple container (opt-in)");
  });

  test("setting values: ids, aliases, auto, native; anything else is refused", () => {
    expect(normalizeBackend("")).toBe("auto");
    expect(normalizeBackend("Bubblewrap")).toBe("bwrap");
    expect(normalizeBackend("container")).toBe("apple");
    expect(normalizeBackend("wsl-containers")).toBe("wslc");
    expect(normalizeBackend("desktop")).toBe("docker-desktop");
    expect(normalizeBackend("off")).toBe("native");
    expect(normalizeBackend("lxc")).toBeNull();
  });
});

// --- Linux: bubblewrap ------------------------------------------------------------------------

const BWRAP_OK = { ok: true, launcher: "bwrap", bwrap: "/usr/bin/bwrap", bwrap_version: "0.9.0", overlay: "kernel", idmap: "subuid", kernel: "6.8.0", apparmor_restrict_unprivileged_userns: 0, root: false, ms: 9 };
const BWRAP_AA = { ok: false, launcher: "bwrap", bwrap: "/usr/bin/bwrap", bwrap_version: "0.9.0", kernel: "6.8.0", apparmor_restrict_unprivileged_userns: 1, code: "apparmor", reason: "AppArmor blocks unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1, Ubuntu 23.10+)", detail: "bwrap: setting up uid map: Permission denied" };
const podmanInfo = { host: { arch: "amd64", os: "linux", security: { rootless: true } }, version: { Version: "4.9.3" } };

function linuxRun(bwrapAnswer: unknown, { podman = true }: { podman?: boolean } = {}) {
  const calls: string[] = [];
  const run: RunCommand = async (bin, args) => {
    calls.push([path.basename(bin), ...args].join(" "));
    if (bin.endsWith("boxrun")) return ok(bwrapAnswer);
    if (bin.endsWith("podman")) return podman ? ok(podmanInfo) : fail("podman: not found", 127);
    return fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
  };
  return { run, calls };
}

describe("box backends: Linux", () => {
  test("farm runs: only backends that keep the box offline; Podman/Docker are skipped, never a silent fallback", async () => {
    const home = tmp();
    const env = { PATH: "/usr/bin", OMNIRUSH_BOX_BIN_DIR: helperBin(), OMNIRUSH_FARM: "1", OMNIRUSH_FARM_RUN: "1" };
    const farm = await detectBackend({ boxHome: home, platform: "linux", home, env, exists: set(boxrunPath({ env }), "/usr/bin/podman"), run: linuxRun(BWRAP_AA).run, fresh: true, all: true, wsl: false });
    expect(farm.ok).toBe(false);
    expect(farm.alternatives?.find((a) => a.backend === "podman")?.reason).toBe("cannot keep a farm session offline");
    const asked = await detectBackend({ boxHome: home, platform: "linux", home, env, exists: set(boxrunPath({ env }), "/usr/bin/podman"), run: linuxRun(BWRAP_OK).run, fresh: true, asked: "podman", wsl: false });
    expect(asked.ok).toBe(false);
    const ok = await detectBackend({ boxHome: home, platform: "linux", home, env, exists: set(boxrunPath({ env }), "/usr/bin/podman"), run: linuxRun(BWRAP_OK).run, fresh: true, wsl: false });
    expect(ok).toMatchObject({ ok: true, backend: "bwrap" });
    if (ok.ok) expect(ok.why).toMatch(/farm mode/);
    // boxsh's `wslc exec` fallback runs outside boxd's network: off in farm runs, kept otherwise.
    const runtime = { name: "wslc", backend: "wslc", bin: "wslc.exe" };
    const base = { key: "k", name: "omnirush-box-k", root: home, croot: home, runtime, home, runFolder: home, run: linuxRun(BWRAP_OK).run, log: () => {}, platform: "win32" as const };
    expect(new Box({ ...base, env: {} }).execFallback()).toBe(true);
    expect(new Box({ ...base, env: { OMNIRUSH_FARM: "1", OMNIRUSH_FARM_RUN: "1" } }).execFallback()).toBe(false);
    // A hackathon event's stock mode (no farm-run marker) keeps the fallback, as before.
    expect(new Box({ ...base, env: { OMNIRUSH_FARM: "1" } }).execFallback()).toBe(true);
  });

  test("bubblewrap first when its probe starts a namespace", async () => {
    const home = tmp();
    const env = { PATH: "/usr/bin", OMNIRUSH_BOX_BIN_DIR: helperBin() };
    const { run } = linuxRun(BWRAP_OK);
    const found = await detectBackend({ boxHome: home, platform: "linux", home, env, exists: set(boxrunPath({ env }), "/usr/bin/podman"), run, fresh: true, wsl: false });
    expect(found).toMatchObject({ ok: true, backend: "bwrap", flavor: "overlayfs", idmap: "subuid", version: "0.9.0" });
    if (found.ok) expect(found.why).toMatch(/bwrap > podman > docker/);
    expect(driverFor(found.ok ? found : null).kind).toBe("bwrap");
  });

  test("AppArmor's userns restriction: one-line reason with the admin fix, rootless Podman is used", async () => {
    const home = tmp();
    const env = { PATH: "/usr/bin", OMNIRUSH_BOX_BIN_DIR: helperBin() };
    const found = await detectBackend({ boxHome: home, platform: "linux", home, env, exists: set(boxrunPath({ env }), "/usr/bin/podman"), run: linuxRun(BWRAP_AA).run, fresh: true, all: true, wsl: false });
    expect(found).toMatchObject({ ok: true, backend: "podman" });
    const bw = found.alternatives?.find((a) => a.backend === "bwrap");
    expect(bw?.ok).toBe(false);
    expect(bw?.reason).toMatch(/AppArmor .*sudo omnirush sandbox enable/);
    expect(bw?.reason).not.toMatch(/\n/);
    // Nothing else either: the project runs natively and says why in one line.
    const none = await detectBackend({ boxHome: home, platform: "linux", home, env, exists: set(boxrunPath({ env })), run: linuxRun(BWRAP_AA, { podman: false }).run, fresh: true, wsl: false });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toMatch(/^bwrap: AppArmor/);
  });

  test("bwrap probe reasons: no bwrap, userns off, helper missing, garbage", async () => {
    expect(explainProbe({ code: "no_bwrap", reason: "bubblewrap (bwrap) is not installed" })).toMatch(/apt install bubblewrap/);
    expect(explainProbe({ code: "userns_off", reason: "x" })).toMatch(/Podman or Docker/);
    const home = tmp();
    const missing = await probeBwrap({ env: { OMNIRUSH_BOX_BIN_DIR: "/nope" }, boxHome: home, exists: () => false, platform: "linux" });
    expect(missing.ok ? "" : missing.reason).toMatch(/boxrun is missing/);
    const garbage = await probeBwrap({ env: { OMNIRUSH_BOX_BIN_DIR: helperBin() }, boxHome: home, exists: () => true, platform: "linux", run: async () => ({ code: 1, stdout: "", stderr: "segfault" }) });
    expect(garbage.ok).toBe(false);
    expect(parseOut('noise\n{"a":1}\n{"ok":true,"port":5}\n')).toEqual({ ok: true, port: 5 });
  });

  test("bwrap candidates: the enabled copy, the system's, then the bundled one; each probed until one starts a box", async () => {
    const bin = helperBin();
    const bundled = path.join(bin, "linux-amd64", "bwrap");
    writeFileSync(bundled, "");
    const present = new Set([ENABLED_BWRAP, "/usr/bin/bwrap", bundled, path.join(bin, "linux-amd64", "boxrun")]);
    const exists = (file: string) => present.has(file);
    expect(bwrapCandidates({ env: { PATH: "/usr/bin", OMNIRUSH_BOX_BIN_DIR: bin }, arch: "x64", exists })).toEqual([
      { path: ENABLED_BWRAP, source: "enabled" }, { path: "/usr/bin/bwrap", source: "system" }, { path: bundled, source: "bundled" },
    ]);
    expect(bwrapCandidates({ env: { OMNIRUSH_BOX_BWRAP: "/x/bwrap" }, exists })).toEqual([{ path: "/x/bwrap", source: "env" }]);
    // The enabled copy fails, the system's is blocked by AppArmor, the bundled one works: it is used.
    const tried: string[] = [];
    const run: RunCommand = async (_bin, args) => {
      const bw = args[args.indexOf("--bwrap") + 1] ?? "";
      tried.push(bw);
      if (bw === bundled) return { code: 0, stdout: JSON.stringify({ ok: true, bwrap: bw, bwrap_version: "0.11.0" }), stderr: "" };
      return { code: 1, stdout: JSON.stringify({ ok: false, code: bw === "/usr/bin/bwrap" ? "apparmor" : "userns_off", reason: "blocked" }), stderr: "" };
    };
    const found = await probeBwrap({ env: { PATH: "/usr/bin", OMNIRUSH_BOX_BIN_DIR: bin }, boxHome: tmp(), arch: "x64", exists, platform: "linux", run });
    expect(found).toMatchObject({ ok: true, bwrap: bundled, version: "0.11.0" });
    expect(tried).toEqual([ENABLED_BWRAP, "/usr/bin/bwrap", bundled]);
    // None works: AppArmor's reason (one admin step fixes it), naming the app's Allow.
    present.delete(bundled);
    const none = await probeBwrap({ env: { PATH: "/usr/bin", OMNIRUSH_BOX_BIN_DIR: bin }, boxHome: tmp(), arch: "x64", exists, platform: "linux", run });
    expect(none).toMatchObject({ ok: false, code: "apparmor" });
    expect(none.ok ? "" : none.reason).toContain("Allow the sandbox");
  });

  test("the setting picks one backend; native turns the box off; the server's allowlist skips the rest", async () => {
    const home = tmp();
    const env = { PATH: "/usr/bin", OMNIRUSH_BOX_BIN_DIR: helperBin() };
    const { run, calls } = linuxRun(BWRAP_OK);
    const asked = await detectBackend({ boxHome: home, platform: "linux", home, env, exists: set(boxrunPath({ env }), "/usr/bin/podman"), run, fresh: true, asked: "podman", wsl: false });
    expect(asked).toMatchObject({ ok: true, backend: "podman" });
    if (asked.ok) expect(asked.why).toMatch(/chosen in Settings/);
    expect(calls.some((c) => c.startsWith("boxrun"))).toBe(false);
    const native = await detectBackend({ boxHome: home, platform: "linux", home, env, exists: () => true, run, fresh: true, asked: "native" });
    expect(native).toMatchObject({ ok: false, native: true });
    const unknown = await detectBackend({ boxHome: home, platform: "linux", home, env, run, fresh: true, asked: "lxc" });
    expect(unknown.ok ? "" : unknown.reason).toMatch(/unknown sandbox backend "lxc"/);
    const allowed = await detectBackend({ boxHome: home, platform: "linux", home, env, exists: set(boxrunPath({ env }), "/usr/bin/podman"), run, fresh: true, all: true, allow: ["podman", "docker"], wsl: false });
    expect(allowed).toMatchObject({ ok: true, backend: "podman" });
    expect(allowed.alternatives?.find((a) => a.backend === "bwrap")?.reason).toBe("not allowed by the server");
  });

  test("the backend setting and the server's allowlist are remembered", () => {
    const state = tmp();
    expect(readBackend(state)).toBe("auto");
    expect(saveBackend(state, "Bubblewrap")).toBe("bwrap");
    expect(askedBackend({ env: {}, stateDir: state })).toEqual({ backend: "bwrap", source: "setting" });
    expect(askedBackend({ env: { OMNIRUSH_BOX_BACKEND: "docker" }, stateDir: state })).toEqual({ backend: "docker", source: "env" });
    expect(() => saveBackend(state, "nope")).toThrow();
    expect(JSON.parse(readFileSync(path.join(state, "box.json"), "utf8"))).toEqual({ backend: "bwrap" });
    expect(rememberServerDefault(state, { local_box: { default: "offer", backends: ["bwrap", "docker", 3] } })).toBe(true);
    expect(serverBackends(state)).toEqual(["bwrap", "docker"]);
    expect(rememberServerDefault(state, { local_box: { default: "offer", backends: ["bwrap", "docker"] } })).toBe(false);
    rememberServerDefault(state, { local_box: { default: "off" } });
    expect(serverBackends(state)).toBeNull();
  });

  test("farm egress: only farm runs give boxd BOXD_EGRESS (bwrap, WSL distro, wslc); other runs keep their exact args", () => {
    expect(boxEgress({})).toBeNull();
    expect(boxEgress({ OMNIRUSH_FARM: "0" })).toBeNull();
    expect(boxEgress({ OMNIRUSH_FARM: "1", OMNIRUSH_FARM_RUN: "1" })).toBe("farm");
    // A hackathon event's stock mode (OMNIRUSH_FARM without the farm-run marker): the network as is.
    expect(boxEgress({ OMNIRUSH_FARM: "1" })).toBeNull();
    expect(boxEgress({ OMNIRUSH_FARM_RUN: "1" })).toBeNull();
    const base = { box: "/b", store: "/s", image: "i", boxd: "/d", portFile: "/p", root: "/r", croot: "/r", runFolder: "/f", token: "t" };
    const plain = upArgs(base);
    expect(upArgs({ ...base, egress: null })).toEqual(plain);
    expect(plain.some((a) => a.startsWith("BOXD_EGRESS"))).toBe(false);
    expect(upArgs({ ...base, egress: "farm" })).toEqual([...plain, "--env", "BOXD_EGRESS=farm"]);
    const wbase = { name: "n", key: "k", root: "C:\\p", croot: "/c/p", image: "img", runFolder: "C:\\r", token: "t", port: 1, env: {} };
    const wplain = createWslcArgs(wbase);
    expect(createWslcArgs({ ...wbase, egress: null })).toEqual(wplain);
    const wfarm = createWslcArgs({ ...wbase, egress: "farm" });
    expect(wfarm).toContain("BOXD_EGRESS=farm");
    expect(wfarm).toContain("ai.omnirush.box.egress=farm");
    expect(wfarm.length).toBe(wplain.length + 4);
  });

  test("bwrap box start: the project at its path, the run folder, boxd on loopback with a port file, nothing of $HOME", () => {
    const args = upArgs({ box: "/h/.omnirush/box/bwrap/boxes/k", store: "/h/.omnirush/box/bwrap/store", image: "abc-amd64", boxd: "/pkg/boxd", portFile: "/h/.omnirush/box/projects/k/boxd.port", root: "/home/u/proj", croot: "/home/u/proj", runFolder: "/h/.omnirush/box/projects/k", pkglog: PKGLOG, token: "t0k", idleMinutes: 90 });
    const binds = args.flatMap((a, i) => (a === "--bind" || a === "--ro-bind" ? [args[i + 1]] : []));
    expect(binds).toEqual(["/home/u/proj=/home/u/proj", "/h/.omnirush/box/projects/k=/run/omnirush", "/h/.omnirush/pkglog-wrappers=/h/.omnirush/pkglog-wrappers", "/h/.omnirush/pkglog/raw=/h/.omnirush/pkglog/raw"]);
    // The wrappers this machine runs are read-only in the box; only the raw folder is writable.
    const pairs = args.flatMap((a, i) => (a === "--bind" || a === "--ro-bind" ? [`${a} ${args[i + 1]}`] : []));
    expect(pairs).toContain("--ro-bind /h/.omnirush/pkglog-wrappers=/h/.omnirush/pkglog-wrappers");
    expect(pairs).toContain("--bind /h/.omnirush/pkglog/raw=/h/.omnirush/pkglog/raw");
    expect(pairs.some((p) => p.startsWith("--bind /h/.omnirush/pkglog-wrappers") || p.startsWith("--bind /h/.omnirush/pkglog="))).toBe(false);
    const env = args.flatMap((a, i) => (a === "--env" ? [args[i + 1]] : []));
    expect(env).toContain("BOXD_LISTEN=127.0.0.1:0");
    expect(env).toContain("BOXD_PORT_FILE=/run/omnirush/boxd.port");
    expect(env).toContain("BOXD_IDLE_EXIT=90");
    expect(env).toContain("BOXD_TOKEN=t0k");
    expect(binds.some((b) => b?.startsWith("/h=") || b?.includes(".ssh"))).toBe(false);
    expect(boxdEnv({ token: "x", croot: "/c" }).filter((kv) => kv.startsWith("BOXD_UID") || kv.startsWith("BOXD_HOME"))).toEqual(["BOXD_UID=0", "BOXD_HOME=/root"]);
  });

  test("the AppArmor profile the CLI installs covers OmniRush's own bwrap only (userns), never the sysctl", () => {
    const profile = apparmorProfile("/usr/local/lib/omnirush/bwrap");
    expect(profile).toMatch(/profile omnirush-bwrap \/usr\/local\/lib\/omnirush\/bwrap flags=\(unconfined\) \{\n  userns,/);
    expect(/sysctl|apparmor_restrict/.test(profile.replace(/^#.*$/gm, ""))).toBe(false);
  });
});

// --- macOS: Apple container -----------------------------------------------------------------

const APPLE_BIN = "/usr/local/bin/container";
const appleVersions = [{ appName: "container", version: "1.5.0", buildType: "release", commit: "abc" }, { appName: "container-apiserver", version: "1.5.0", buildType: "release", commit: "abc" }];

describe("box backends: macOS", () => {
  test("Apple container: macOS 26 on Apple silicon, the 1.x line, its service running", async () => {
    expect(macosMajor("25.0.0", null)).toBe(26);
    expect(macosMajor("24.6.0", null)).toBe(15);
    expect(macosMajor("20.1.0", null)).toBe(11);
    expect(macosMajor("19.6.0", null)).toBe(null);
    // This Mac's own version wins over the kernel number (macOS 27.0.1 reports Darwin 27.0.0).
    expect(macosMajor("27.0.0", "27.0.1")).toBe(27);
    expect(systemProductVersion(() => "<dict><key>ProductVersion</key>\n\t<string>27.0.1</string></dict>")).toBe("27.0.1");
    expect(systemProductVersion(() => { throw new Error("ENOENT"); })).toBe(null);
    expect(parseVersions(JSON.stringify(appleVersions))).toEqual({ version: "1.5.0", server: "1.5.0" });
    expect(parseVersions("container CLI version 0.5.0 (build: release, commit: 1234)").version).toBe("0.5.0");
    const base = { platform: "darwin" as const, arch: "arm64", release: "25.1.0", env: { PATH: "/usr/bin" }, exists: set(APPLE_BIN) };
    const good: RunCommand = async (_bin, args) => (args[1] === "version" ? ok(appleVersions) : ok("apiserver is running"));
    expect(await probeApple({ ...base, run: good })).toMatchObject({ ok: true, version: "1.5.0", arch: "arm64", vm: true });
    const reason = async (run: RunCommand, extra: Record<string, unknown> = {}) => {
      const r = await probeApple({ ...base, ...extra, run });
      return r.ok ? "" : r.reason;
    };
    expect(await reason(good, { arch: "x64" })).toMatch(/Apple silicon/);
    expect(await reason(good, { release: "24.6.0" })).toMatch(/macOS 26 or later \(this is macOS 15\)/);
    expect(await reason(good, { exists: () => false })).toMatch(/not installed/);
    expect(await reason(async (_b, args) => (args[1] === "version" ? ok([{ appName: "container", version: "0.11.0" }]) : ok("")))).toMatch(/0\.11\.0 is outside the supported 1\.x line/);
    expect((await probeApple({ ...base, run: async (_b, args) => (args[1] === "version" ? ok([{ appName: "container", version: "2.0.0" }]) : ok("")) })).ok).toBe(false);
    expect(await reason(async (_b, args) => (args[1] === "version" ? ok([{ appName: "container", version: "1.4.1" }]) : fail("apiserver is not running and not registered with launchd")))).toMatch(/container system start/);
    expect(versionAtLeast("1.4.1", APPLE.min) && !versionAtLeast("1.4.1", APPLE.below)).toBe(true);
  });

  test("Apple container: create args, list/inspect JSON, image digest", () => {
    const args = createAppleArgs({ name: "omnirush-box-k", key: "k", root: "/Users/sam/proj", croot: "/Users/sam/proj", image: `ghcr.io/omnirush-ai/box-base@sha256:${"a".repeat(64)}`, runFolder: "/Users/sam/.omnirush/box/projects/k", token: "t", port: 50123, env: { OMNIRUSH_BOX_MEMORY: "6G" } });
    expect(args).toContain("type=bind,source=/Users/sam/proj,target=/Users/sam/proj");
    expect(args).toContain("type=bind,source=/Users/sam/.omnirush/box/projects/k/bin,target=/opt/omnirush/bin,readonly");
    expect(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2)).toEqual(["-p", "127.0.0.1:50123:7777"]);
    expect(args[args.indexOf("--memory") + 1]).toBe("6G");
    expect(args[args.indexOf("--entrypoint") + 1]).toBe("/opt/omnirush/bin/boxd");
    expect(args).toContain("--init");
    expect(args).toContain("ai.omnirush.box.port=50123");
    const snap = { configuration: { id: "omnirush-box-k", image: { reference: "ghcr.io/omnirush-ai/box-base:1", descriptor: { digest: `sha256:${"b".repeat(64)}` } }, labels: { "ai.omnirush.box": "1", "ai.omnirush.box.key": "k" } }, status: "running", networks: [{ network: "default", hostname: "omnirush-box-k", ipv4Address: "192.168.64.7/24", ipv4Gateway: "192.168.64.1" }] };
    expect(snapshotInfo(snap)).toMatchObject({ running: true, address: "192.168.64.7", digest: `sha256:${"b".repeat(64)}` });
    expect(snapshotInfo({ ...snap, networks: [{ address: "192.168.64.9/24" }] }).address).toBe("192.168.64.9");
    expect(findDigest([{ name: "x", index: { digest: `sha256:${"c".repeat(64)}` } }])).toBe(`sha256:${"c".repeat(64)}`);
    expect(findDigest({ variants: [{ config: { digest: `sha256:${"d".repeat(64)}` } }] })).toBe(`sha256:${"d".repeat(64)}`);
  });

  test("ranking: OrbStack, colima, Docker Desktop through docker contexts; Apple container never probed unasked", async () => {
    const docker = "/usr/local/bin/docker";
    const infos: Record<string, unknown> = { orbstack: { OperatingSystem: "OrbStack", Name: "orbstack", ServerVersion: "27.0", OSType: "linux", Architecture: "aarch64" }, colima: { OperatingSystem: "Ubuntu 24.04", Name: "colima", ServerVersion: "27.1", OSType: "linux" }, "desktop-linux": { OperatingSystem: "Docker Desktop", ServerVersion: "28.0", OSType: "linux" } };
    const contexts = ["desktop-linux", "colima", "default"].map((Name) => JSON.stringify({ Name, DockerEndpoint: `unix:///x/${Name}.sock` })).join("\n");
    const run: RunCommand = async (bin, args) => {
      if (bin === APPLE_BIN) return fail("not installed", 127);
      if (args[0] === "context") return ok(contexts);
      if (args[0] === "--context") return infos[args[1] ?? ""] ? ok(infos[args[1] ?? ""]) : fail("Cannot connect to the Docker daemon");
      return fail("no");
    };
    const home = tmp();
    // (the OmniRush VM off: these are the runtimes it falls back to)
    const found = await detectBackend({ boxHome: home, platform: "darwin", arch: "arm64", release: "24.0.0", home: "/Users/sam", env: { PATH: "/usr/local/bin", OMNIRUSH_BOX_LIMA: "0" }, exists: set(docker), run, fresh: true, all: true });
    expect(found).toMatchObject({ ok: true, backend: "colima", prefix: ["--context", "colima"] });
    expect(found.alternatives?.find((a) => a.backend === "apple")?.reason).toMatch(/opt-in only/);
    expect(found.alternatives?.some((a) => a.backend === "docker-desktop" && a.ok)).toBe(true);
    const none = await detectBackend({ boxHome: home, platform: "darwin", home: "/Users/sam", env: { PATH: "/usr/bin", OMNIRUSH_BOX_LIMA: "0" }, exists: () => false, run, fresh: true });
    expect(none).toMatchObject({ ok: false, hint: "colima" });
  });

  test("Apple container: opt-in only, used when chosen, never started", async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === APPLE_BIN) return args[1] === "version" ? ok(appleVersions) : ok("apiserver is running");
      return fail("Cannot connect to the Docker daemon");
    };
    const base = { boxHome: tmp(), platform: "darwin" as const, arch: "arm64", release: "26.0.0", home: "/Users/sam", env: { PATH: "/usr/local/bin", OMNIRUSH_BOX_LIMA: "0" }, exists: set(APPLE_BIN), run, fresh: true };
    const auto = await detectBackend(base);
    expect(auto.ok).toBe(false);
    expect(calls.some(([bin]) => bin === APPLE_BIN)).toBe(false);
    const asked = await detectBackend({ ...base, asked: "apple-container" });
    expect(asked).toMatchObject({ ok: true, backend: "apple" });
    expect(calls.some((c) => c.slice(1).join(" ") === "system start")).toBe(false);
    const stopped = await probeApple({ ...base, run: async (_b, args) => (args[1] === "version" ? ok(appleVersions) : fail("apiserver is not running")) });
    expect(stopped.ok ? "" : stopped.reason).toMatch(/never starts it/);
  });
});

// --- Windows: the OmniRush WSL distro --------------------------------------------------------

const WSL = "C:\\Windows\\System32\\wsl.exe";
const winEnv = { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" };
const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);

function wslRun({ status = ok("Default Version: 2\r\n"), list = ok("  NAME  STATE  VERSION\r\n"), version = ok("WSL version: 2.6.1.0\r\nKernel version: 6.6.87.2-1\r\n") }: { status?: RunResult; list?: RunResult; version?: RunResult } = {}): RunCommand {
  return async (_bin, args) => {
    if (args[0] === "--status") return status;
    if (args[0] === "--list") return list;
    if (args[0] === "--version") return version;
    return fail("unexpected");
  };
}

/** A child process with pipes and no process behind it (the WSL keeper's stand-in). */
class FakeChild extends ChildProcess {
  override stdout = new PassThrough();
  override stderr = new PassThrough();
  override stdin = new PassThrough();
}
const fakeChild = () => new FakeChild();

describe("box backends: Windows", () => {
  test("WSL rootfs download: through the app's fetch, https only, checked against its sha256", async () => {
    const dir = tmp();
    const body = Buffer.from("rootfs bytes");
    const sum = createHash("sha256").update(body).digest("hex");
    const asked: Array<[string, RequestInit | undefined]> = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      asked.push([url, init]);
      return Object.defineProperty(new Response(body, { status: 200 }), "url", { value: url });
    };
    const dest = path.join(dir, "rootfs.tar.gz");
    expect(await download("https://example.invalid/r.tar.gz", dest, sum, { fetcher })).toBe(dest);
    expect(readFileSync(dest, "utf8")).toBe("rootfs bytes");
    expect(asked[0]?.[1]?.redirect).toBe("follow");
    await expect(download("https://example.invalid/r.tar.gz", path.join(dir, "bad"), "0".repeat(64), { fetcher })).rejects.toThrow(/sha256 mismatch/);
    await expect(download("http://example.invalid/r.tar.gz", path.join(dir, "plain"), null, { fetcher })).rejects.toThrow(/https only/);
    await expect(download("https://example.invalid/missing", path.join(dir, "m"), null, { fetcher: async () => new Response("no", { status: 404 }) })).rejects.toThrow(/HTTP 404/);
  });

  test("wsl.exe output: UTF-16LE with a BOM or UTF-8, the verbose list with its default marker", () => {
    const list = "  NAME            STATE           VERSION\r\n* Ubuntu-24.04    Running         2\r\n  OmniRushBox     Stopped         2\r\n  Legacy Distro   Stopped         1\r\n";
    expect(decodeWsl(utf16(list))).toBe(decodeWsl(Buffer.from(list)));
    expect(parseWslList(utf16(list))).toEqual([
      { name: "Ubuntu-24.04", state: "Running", version: "2", isDefault: true },
      { name: "OmniRushBox", state: "Stopped", version: "2", isDefault: false },
      { name: "Legacy Distro", state: "Stopped", version: "1", isDefault: false },
    ]);
    // What runCommand hands over when it read UTF-16 as UTF-8: NULs between letters.
    expect(decodeWsl("W\u0000S\u0000L\u0000")).toBe("WSL");
  });

  test("distro probe: not enabled is the one-time admin hint (never an install); WSL 1 and unpublished images say so", async () => {
    const reason = (r: Awaited<ReturnType<typeof probeWslDistro>>) => (r.ok ? "" : r.reason);
    const off = await probeWslDistro({ platform: "win32", env: winEnv, exists: set(WSL), run: wslRun({ status: fail(Buffer.from("Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.", "utf16le").toString("utf8")) }) });
    expect(reason(off)).toBe(ENABLE_HINT);
    expect(ENABLE_HINT).toMatch(/administrator terminal: `wsl --install --no-distribution`, then restart/);
    expect(reason(await probeWslDistro({ platform: "win32", env: winEnv, exists: () => false, run: wslRun() }))).toBe(ENABLE_HINT);
    const v1 = await probeWslDistro({ platform: "win32", env: { ...winEnv, OMNIRUSH_BOX_WSL_ROOTFS: "C:\\x.tar.gz" }, exists: set(WSL), run: wslRun({ list: ok("  NAME STATE VERSION\r\n  OmniRushBox  Stopped  1\r\n") }) });
    expect(reason(v1)).toMatch(/WSL 1/);
    expect(reason(await probeWslDistro({ platform: "win32", env: winEnv, exists: set(WSL), run: wslRun(), pins: { version: "x", distro: "OmniRushBox", base: "x", assets: { amd64: { url: null, sha256: null, bytes: null } } } as never }))).toMatch(/not published yet/);
    // The shipped wsl.json pins a published image.
    expect((await probeWslDistro({ platform: "win32", arch: "x64", env: winEnv, exists: set(WSL), run: wslRun() })).ok).toBe(true);
    const ready = await probeWslDistro({ platform: "win32", env: { ...winEnv, OMNIRUSH_BOX_WSL_ROOTFS: "C:\\x.tar.gz" }, exists: set(WSL), run: wslRun() });
    expect(ready).toMatchObject({ ok: true, installed: false, distro: "OmniRushBox", version: "2.6.1.0" });
    const installed = await probeWslDistro({ platform: "win32", env: winEnv, exists: set(WSL), run: wslRun({ list: ok(utf16("  NAME  STATE  VERSION\r\n  OmniRushBox  Running  2\r\n").toString("latin1")) }) });
    expect(installed.ok).toBe(true);
  });

  test("distro box: Windows paths bound as /mnt/c into /c, commands as root without a shell", () => {
    expect(inDistro({ distro: "OmniRushBox" }, ["/opt/omnirush/boxrun", "status"])).toEqual(["-d", "OmniRushBox", "-u", "root", "--cd", "/", "--exec", "/opt/omnirush/boxrun", "status"]);
    const wslPath = (p: string) => `/mnt/${p[0]!.toLowerCase()}/${p.slice(3).replace(/\\/g, "/")}`;
    const args = upArgs({ box: "/var/lib/omnirush/boxes/k", store: "/var/lib/omnirush/store", image: "id", boxd: "/opt/omnirush/boxd", portFile: "/mnt/c/Users/Sam/.omnirush/box/projects/k/boxd.port", root: "C:\\Users\\Sam\\proj", croot: "/c/Users/Sam/proj", runFolder: "C:\\Users\\Sam\\.omnirush\\box\\projects\\k", token: "t", platform: "win32", mapPath: wslPath });
    expect(args).toContain("/mnt/c/Users/Sam/proj=/c/Users/Sam/proj");
    expect(args).toContain("/mnt/c/Users/Sam/.omnirush/box/projects/k=/run/omnirush");
  });

  test("keeper: the first JSON line (UTF-16 or not) gives the port; the keeper stays as a child", async () => {
    let spawnedArgs: string[] = [];
    const kept = await startKeeper({ bin: WSL, distro: "OmniRushBox" }, ["up", "--box", "/var/lib/omnirush/boxes/k"], {
      timeoutMs: 2_000,
      spawnImpl: (_bin, args) => {
        spawnedArgs = args;
        const child = fakeChild();
        setTimeout(() => child.stdout.emit("data", utf16('{"ok":true,"reused":false,"pid":41,"port":40123,"launcher":"unshare","overlay":"kernel"}\n')), 5);
        return child;
      },
    });
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(kept.out.port).toBe(40123);
    expect(spawnedArgs.at(-1)).toBe("--foreground");
    const bad = await startKeeper({ bin: WSL, distro: "OmniRushBox" }, ["up"], {
      timeoutMs: 2_000,
      spawnImpl: () => {
        const child = fakeChild();
        setTimeout(() => child.emit("close", 1), 5);
        return child;
      },
    });
    expect(bad.ok).toBe(false);
  });

  const WSLC = "C:\\Program Files\\WSL\\wslc.exe";

  test("wslc: `wslc version` JSON or text; 3.0.1+ only; an older WSL gets the `wsl --update` hint, a missing one the enable hint", async () => {
    expect(parseWslcVersion('{"Client":{"Version":"3.0.1.0"}}')).toBe("3.0.1.0");
    expect(parseWslcVersion(utf16("wslc 3.0.2.0\r\n"))).toBe("3.0.2.0");
    const good = await probeWslc({ platform: "win32", env: winEnv, exists: set(WSLC), run: async () => ok('{"Client":{"Version":"3.0.1.0"}}') });
    expect(good).toMatchObject({ ok: true, version: "3.0.1.0", backend: "wslc", flavor: "wslc" });
    const reason = (r: Awaited<ReturnType<typeof probeWslc>>) => (r.ok ? "" : r.reason);
    expect(reason(await probeWslc({ platform: "win32", env: winEnv, exists: set(WSLC), run: async () => ok('{"Client":{"Version":"2.9.4.0"}}') }))).toMatch(/wsl --update/);
    const oldWsl = await probeWslc({ platform: "win32", env: winEnv, exists: set(WSL), run: async (_bin, args) => (args[0] === "--version" ? ok(utf16("WSL version: 2.6.1.0\r\n").toString("latin1")) : fail("x")) });
    expect(reason(oldWsl)).toBe(`${UPDATE_HINT}; this is WSL 2.6.1.0`);
    expect(reason(await probeWslc({ platform: "win32", env: winEnv, exists: () => false, run: async () => fail("x") }))).toBe(ENABLE_HINT);
  });

  test("wslc: create args take the Windows path as the bind source, publish boxd on loopback, upper-case memory, no --init", () => {
    const args = createWslcArgs({ name: "omnirush-box-k", key: "k", root: "C:\\Users\\Sam\\proj", croot: "/c/Users/Sam/proj", image: "ghcr.io/omnirush-ai/box-base:1", runFolder: "C:\\Users\\Sam\\.omnirush\\box\\projects\\k", token: "t", port: 50999, env: { OMNIRUSH_BOX_MEMORY: "4g" } });
    expect(args.slice(0, 2)).toEqual(["container", "create"]);
    expect(args).toContain("type=bind,source=C:\\Users\\Sam\\proj,target=/c/Users/Sam/proj");
    expect(args).toContain("type=bind,source=C:\\Users\\Sam\\.omnirush\\box\\projects\\k\\bin,target=/opt/omnirush/bin,readonly");
    expect(args).toContain("127.0.0.1:50999:7777");
    expect(args[args.indexOf("-m") + 1]).toBe("4G");
    expect(args).not.toContain("--init");
    expect(args.at(-1)).toBe("ghcr.io/omnirush-ai/box-base:1");
  });

  test("wslc: list JSON (an array or one object per line), labels as a map or docker's string", () => {
    const rows = [{ ID: "abc", Names: "omnirush-box-k", Image: "ghcr.io/omnirush-ai/box-base:1", State: "running", Labels: { "ai.omnirush.box": "1", "ai.omnirush.box.key": "k" }, Size: "57.2MB (virtual 1.1GB)" }];
    expect(parseJsonRows(JSON.stringify(rows))).toEqual(rows);
    expect(parseJsonRows(rows.map((r) => JSON.stringify(r)).join("\n"))).toEqual(rows);
    expect(labelsOf("a=1,b=x=y")).toEqual({ a: "1", b: "x=y" });
  });

  test("ranking: wslc, then the OmniRush distro, then Docker Desktop", async () => {
    const docker = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
    const desktop = { ServerVersion: "27.3.1", OSType: "linux", OperatingSystem: "Docker Desktop" };
    const run: RunCommand = async (bin, args) => {
      if (bin === WSLC) return ok('{"Client":{"Version":"3.0.1.0"}}');
      if (bin === WSL) return wslRun()(bin, args);
      if (args[0] === "context") return ok("");
      return ok(desktop);
    };
    const env = { ...winEnv, OMNIRUSH_BOX_WSL_ROOTFS: "C:\\x.tar.gz" };
    expect(await detectBackend({ platform: "win32", home: "C:\\Users\\sam", env, exists: set(WSLC, WSL, docker), run, fresh: true })).toMatchObject({ backend: "wslc" });
    const noWslc = await detectBackend({ platform: "win32", home: "C:\\Users\\sam", env, exists: set(WSL, docker), run, fresh: true, all: true });
    expect(noWslc).toMatchObject({ ok: true, backend: "wsl" });
    expect(noWslc.alternatives?.find((a) => a.backend === "wslc")?.reason).toMatch(/wsl --update/);
    expect(await detectBackend({ platform: "win32", home: "C:\\Users\\sam", env, exists: set(WSLC, WSL, docker), run, fresh: true, asked: "docker-desktop" })).toMatchObject({ backend: "docker-desktop" });
  });
});

// --- the record, the upload label, the desktop status ----------------------------------------

describe("box backends: record, label, status", () => {
  test("record and label: the backend is named; boxsh gets no exec fallback where there is no exec", () => {
    const home = tmp();
    const runFolder = path.join(home, "projects", "k");
    mkdirSync(runFolder, { recursive: true });
    const run: RunCommand = async () => ok("");
    const box = new Box({ key: "k", name: "omnirush-box-k", root: "/p", croot: "/p", runtime: { name: "bwrap", backend: "bwrap", bin: "/pkg/boxrun", version: "0.9.0", flavor: "overlayfs", rootless: true, arch: "amd64" }, home, runFolder, run, log: () => {}, platform: "linux", env: {} });
    box.connect({ port: 5, token: "t", uid: 0, gid: 0, containerId: "bwrap_k_1", imageId: `sha256:${"e".repeat(64)}` });
    box.writeRecord();
    const rec = JSON.parse(readFileSync(path.join(home, "boxes", "k.json"), "utf8"));
    expect({ backend: rec.backend, runtime: rec.runtime, args: rec.runtime_args }).toEqual({ backend: "bwrap", runtime: "", args: [] });
    mkdirSync(path.join(home, "chains", "k"), { recursive: true });
    writeFileSync(path.join(home, "chains", "k", "image.json"), JSON.stringify({ ref: "ghcr.io/omnirush-ai/box-base:2026.10.1", digest: `sha256:${"f".repeat(64)}`, stack: "base" }));
    const label = box.label();
    expect(label.backend).toBe("bwrap");
    expect(label.image.digest).toBe(`sha256:${"f".repeat(64)}`);
    const docker = new Box({ key: "d", name: "omnirush-box-d", root: "/p", croot: "/p", runtime: { name: "docker", backend: "docker-desktop", bin: "/usr/bin/docker", prefix: ["--context", "desktop-linux"] }, home, runFolder, run, log: () => {}, platform: "linux", env: {} });
    docker.connect({ port: 6, token: "t", uid: 0, gid: 0, containerId: "c", imageId: "i" });
    docker.writeRecord();
    const drec = JSON.parse(readFileSync(path.join(home, "boxes", "d.json"), "utf8"));
    expect({ backend: drec.backend, runtime: drec.runtime, args: drec.runtime_args }).toEqual({ backend: "docker-desktop", runtime: "/usr/bin/docker", args: ["--context", "desktop-linux"] });
  });

  test("files used read a non-container box through its exec (boxsh), not `docker exec`", async () => {
    if (process.platform === "win32") return;
    const dir = tmp();
    const file = path.join(dir, "note.txt");
    writeFileSync(file, "hello");
    const view = sandboxFilesUsed({ container: "omnirush-box-k", manifest: { home: "/root", workspaces: [] }, cwd: dir, hostHome: null, docker: "/nonexistent/docker", exec: { bin: "/bin/sh", args: ["-c", 'exec "$0" "$@"'], env: { OMNIRUSH_BOX_KEY: "k" } } });
    const facts = await view?.view.inspect([file], 1024);
    expect(facts?.get(file)).toMatchObject({ kind: "file", size: 5 });
  });

  test("the settings card's status: the backend, its version and why, the others, the setting and its choices", async () => {
    const stateDir = tmp();
    const home = tmp();
    const root = tmp();
    const workspace: BoxWorkspace = { id: "ws_1", path: root, workspaceType: "local" };
    const settings = new Map<string, { mode: "on" | "off" | null; offered: boolean }>([["ws_1", { mode: "on", offered: true }]]);
    const env = { OMNIRUSH_BOX_HOME: home, OMNIRUSH_BOX_BIN_DIR: tmp(), PATH: "", OMNIRUSH_BOX_RUNTIME: "/nonexistent/docker" };
    const boxes = new BoxService({
      stateDir,
      readSettings: async (id) => settings.get(id) ?? { mode: null, offered: false },
      writeSettings: async () => {},
      workspaces: () => [workspace],
      pluginPath: () => "/plugins/omnirush-box.js",
      env,
    });
    const status = await boxes.status(workspace, { fresh: true });
    expect(status.backendSetting).toMatchObject({ value: "auto", source: "auto" });
    expect(status.backendSetting.choices[0]).toEqual({ id: "auto", label: "Automatic" });
    expect(status.backendSetting.choices.at(-1)?.id).toBe("native");
    expect(status.backend).toMatchObject({ id: null, allowed: null });
    expect(status.backend?.why).toBeTruthy();
    expect(status.backend?.alternatives.every((alt) => typeof alt.id === "string" && typeof alt.ok === "boolean")).toBe(true);
    expect(await boxes.setBackend("native")).toBe("native");
    const native = await boxes.status(workspace, { fresh: true });
    expect(native.backendSetting).toMatchObject({ value: "native", source: "setting" });
    expect(native.state).toBe("unavailable");
    await expect(boxes.setBackend("lxc")).rejects.toThrow(/unknown sandbox backend/);
    rememberServerDefault(stateDir, { local_box: { default: "off", backends: ["podman"] } });
    await boxes.setBackend("auto");
    expect((await boxes.status(workspace, { fresh: true })).backend?.allowed).toEqual(["podman"]);
  });
});

describe("box install log: the wrappers read-only", () => {
  test("wrappers read-only and raw writable on every backend; the layout a box was made with decides", () => {
    const wpk = {
      root: "C:\\Users\\Sam\\.omnirush\\pkglog",
      tools: "C:\\Users\\Sam\\.omnirush\\pkglog-wrappers",
      raw: "C:\\Users\\Sam\\.omnirush\\pkglog\\raw",
      bin: "C:\\Users\\Sam\\.omnirush\\pkglog-wrappers\\bin-0123456789ab",
      py: "C:\\Users\\Sam\\.omnirush\\pkglog-wrappers\\py-0123456789ab",
      legacy: { bin: "C:\\Users\\Sam\\.omnirush\\pkglog\\bin-0123456789ab", py: "C:\\Users\\Sam\\.omnirush\\pkglog\\py-0123456789ab" },
    };
    const apple = createAppleArgs({ name: "n", key: "k", root: "/Users/u/p", croot: "/Users/u/p", image: "img", runFolder: "/Users/u/.omnirush/box/projects/k", pkglog: { tools: "/Users/u/.omnirush/pkglog-wrappers", raw: "/Users/u/.omnirush/pkglog/raw" }, token: "t", port: 1234, env: {} });
    const appleMounts = apple.filter((_, i) => apple[i - 1] === "--mount");
    expect(appleMounts).toContain("type=bind,source=/Users/u/.omnirush/pkglog-wrappers,target=/Users/u/.omnirush/pkglog-wrappers,readonly");
    expect(appleMounts).toContain("type=bind,source=/Users/u/.omnirush/pkglog/raw,target=/Users/u/.omnirush/pkglog/raw");
    expect(appleMounts.some((m) => m.includes("target=/Users/u/.omnirush/pkglog,") || m.endsWith("target=/Users/u/.omnirush/pkglog"))).toBe(false);
    expect(apple).toContain("ai.omnirush.box.pkglog=2");
    const wslc = createWslcArgs({ name: "n", key: "k", root: "C:\\p", croot: "/c/p", image: "img", runFolder: "C:\\r", pkglog: wpk, token: "t", port: 1234, env: {} });
    const wslcMounts = wslc.filter((_, i) => wslc[i - 1] === "--mount");
    expect(wslcMounts).toContain("type=bind,source=C:\\Users\\Sam\\.omnirush\\pkglog-wrappers,target=/c/Users/Sam/.omnirush/pkglog-wrappers,readonly");
    expect(wslcMounts).toContain("type=bind,source=C:\\Users\\Sam\\.omnirush\\pkglog\\raw,target=/c/Users/Sam/.omnirush/pkglog/raw");
    expect(wslc).toContain("ai.omnirush.box.pkglog=2");
    // Their mounts are not read back: the label tells the layout (no label: a box made before).
    expect(appleInstallLogMounts({ "ai.omnirush.box.pkglog": "2" }, PKGLOG)).toEqual(["/h/.omnirush/pkglog-wrappers", "/h/.omnirush/pkglog/raw"]);
    expect(appleInstallLogMounts({}, PKGLOG)).toEqual(["/h/.omnirush/pkglog"]);
    expect(wslcInstallLogMounts({}, wpk)).toEqual(["/c/Users/Sam/.omnirush/pkglog"]);
    // The WSL distro backend (boxrun under WSL): the same split, through /mnt/<drive>.
    const wslUp = upArgs({ box: "/b", store: "/s", image: "i", boxd: "/opt/omnirush/boxd", portFile: "/p", root: "C:\\p", croot: "/c/p", runFolder: "C:\\r", pkglog: wpk, token: "t", platform: "win32", mapPath: (p) => `/mnt/${p[0]!.toLowerCase()}/${p.slice(3).replaceAll("\\", "/")}` });
    const wslPairs = wslUp.flatMap((a, i) => (a === "--bind" || a === "--ro-bind" ? [`${a} ${wslUp[i + 1]}`] : []));
    expect(wslPairs).toContain("--ro-bind /mnt/c/Users/Sam/.omnirush/pkglog-wrappers=/c/Users/Sam/.omnirush/pkglog-wrappers");
    expect(wslPairs).toContain("--bind /mnt/c/Users/Sam/.omnirush/pkglog/raw=/c/Users/Sam/.omnirush/pkglog/raw");
    // Which wrappers a box uses: the read-only ones when both folders are mounted; a box made
    // before (all of pkglog/ read-write) its own copies there; none when it has neither.
    expect(installLogLayout(["/home/u/p", "/run/omnirush", "/h/.omnirush/pkglog-wrappers", "/h/.omnirush/pkglog/raw"], PKGLOG, "linux")).toBe("ro");
    expect(installLogLayout(["/home/u/p", "/run/omnirush", "/h/.omnirush/pkglog"], PKGLOG, "linux")).toBe("legacy");
    expect(installLogLayout(["/home/u/p", "/run/omnirush", "/h/.omnirush/pkglog-wrappers"], PKGLOG, "linux")).toBe(null);
    expect(installLogLayout(["/home/u/p"], PKGLOG, "linux")).toBe(null);
  });

  test("a box's install-log environment: the read-only wrappers, or for a box made before its own copies", () => {
    const dir = tmp();
    const box = new Box({ key: "k", name: "n", root: "/home/u/p", croot: "/home/u/p", runtime: { name: "bwrap", bin: "boxrun" }, home: dir, runFolder: dir, run: async () => ({ code: 0, stdout: "", stderr: "" }), log: () => {}, platform: "linux", env: { TZ: "UTC" } });
    box.useInstallLog(PKGLOG);
    expect(readFileSync(path.join(dir, "env"), "utf8").trim().split("\n")).toEqual([
      "TZ=UTC",
      "BOXD_PATH_PREFIX=/h/.omnirush/pkglog-wrappers/bin-0123456789ab",
      "PYTHONPATH=/h/.omnirush/pkglog-wrappers/py-0123456789ab",
      "BOXD_CHOWN_DIRS=/h/.omnirush/pkglog/raw",
    ]);
    box.useInstallLog({ ...PKGLOG, bin: PKGLOG.legacy.bin, py: PKGLOG.legacy.py });
    expect(readFileSync(path.join(dir, "env"), "utf8")).toMatch(/^BOXD_PATH_PREFIX=\/h\/\.omnirush\/pkglog\/bin-0123456789ab$/m);
  });
});
