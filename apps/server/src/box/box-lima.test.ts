// backends/lima.ts (ported from the CLI's src/box/backends/lima.js): OmniRush's own
// Lima VM on macOS, against limactl's real output, mocked (no VM is started): the
// probe and its place first in the macOS order, the VM's config, the owner lock
// and the leases the one VM shared by the CLI and the desktop app needs, the idle
// stop (the watcher run for real against a stub limactl), the retry after a VM
// that went away (sleep), the contract, the setup's progress lines, and a box
// start through the keeper.
import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { detectBackend, driverFor, normalizeBackend, runtimeBackend } from "./backends/index.js";
import {
  BASE_MOUNTS, HELPER_SCRIPT, LIMA_ARCH, PROVISION, VM_CONTRACT, alive, clearStale, contractFor, contractVerdict, ensureLimactl, ensureVm, fetchChecked, findLimactl, idleMain, idleStep, idleStopMinutes,
  inVm, keepIdleWatch, limaAsset, limaDir, limaDriver, limaEnv, limaError, limaHome, liveLeases, loadDarwinSetup, lockVm, parseList, probeLima, setupLine, startKeeper, stopIfIdle,
  selfStart, syncHelpers, takeLease, uncovered, vmAway, vmCall, vmConfig, vmImage, vmMounts, vmResources, vmRow, type LimaRuntime,
} from "./backends/lima.js";
import type { SpawnLike } from "./backends/types.js";
import { inProcessLog, pullLog, setupWait } from "./launch.js";
import { parseSetupLines, pullProgress } from "./pull-progress.js";
import type { RunCommand, RunResult } from "./run.js";

const ok = (stdout: unknown = ""): RunResult => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: "", stderr });
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "box-lima-"));
const GiB = 1024 ** 3;
const DEAD = 2 ** 22 + 12345;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeLimactl(dir: string): string {
  const bin = path.join(dir, "limactl");
  writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  return bin;
}

type VmState = { status: string | null; mounts?: string[]; wantMounts?: string[]; startFails?: string };
type Call = { bin: string; args: string[]; env?: NodeJS.ProcessEnv; input?: string | Buffer };

/** A limactl stub: `list` answers from `state` ({ status, mounts }), shell calls are recorded. */
function limaRun(state: VmState, { onShell = () => ok(""), calls = [] as Call[] }: { onShell?: (argv: string[], opts: { input?: string | Buffer; onLine?: (s: "stdout" | "stderr", l: string) => void }) => RunResult; calls?: Call[] } = {}): RunCommand {
  return async (bin, args, opts = {}) => {
    calls.push({ bin, args, env: opts.env, input: opts.input });
    if (args[0] === "--version") return ok("limactl version 2.2.1\n");
    if (args[0] === "list") return state.status ? ok(`${JSON.stringify({ name: "omnirush-box", status: state.status, config: { mounts: (state.mounts ?? []).map((m) => ({ location: m, mountPoint: m, writable: true })) } })}\n`) : ok("");
    if (args.includes("start")) { if (state.startFails) return fail(`time="x" level=fatal msg="${state.startFails}"`); state.status = "Running"; if (!state.mounts) state.mounts = state.wantMounts ?? []; return ok(""); }
    if (args.includes("stop")) { state.status = "Stopped"; return ok(""); }
    if (args.includes("edit")) { const set = args[args.indexOf("--set") + 1]!; state.mounts = JSON.parse(set.replace(/^\.mounts = /, "")).map((m: { location: string }) => m.location); return ok(""); }
    if (args.includes("delete")) { state.status = null; return ok(""); }
    if (args[0] === "shell") return onShell(args.slice(args.indexOf("-n") + 1), opts);
    return fail("unexpected");
  };
}

describe("lima: the probe and the order", () => {
  test("macOS only, 13 or later, off by OMNIRUSH_BOX_LIMA=0; nothing downloaded yet is still the pick (it sets itself up)", async () => {
    const home = tmp();
    expect((await probeLima({ platform: "linux", home }) as { reason: string }).reason).toMatch(/for macOS/);
    expect((await probeLima({ platform: "darwin", env: { OMNIRUSH_BOX_LIMA: "0" }, home }) as { reason: string }).reason).toMatch(/OMNIRUSH_BOX_LIMA=0/);
    const old = await probeLima({ platform: "darwin", release: "21.6.0", env: {}, home, tools: null });
    expect(old).toMatchObject({ ok: false, code: "old_macos" });
    const fresh = await probeLima({ platform: "darwin", arch: "arm64", release: "25.0.0", env: {}, home, tools: null, run: async () => { throw new Error("nothing is run before limactl is here"); } });
    expect(fresh).toMatchObject({ ok: true, backend: "lima", installed: false, bin: "", arch: "arm64", instance: "omnirush-box", home });
    expect((await probeLima({ platform: "darwin", release: "25.0.0", env: { OMNIRUSH_BOX_LIMACTL: "/nope/limactl" }, home, tools: null }) as { reason: string }).reason).toMatch(/OMNIRUSH_BOX_LIMACTL/);
  });

  test("a limactl here reports the VM's state; a VM that failed to start is skipped for an hour unless chosen by name", async () => {
    const home = tmp();
    const bin = fakeLimactl(home);
    const state: VmState = { status: "Stopped" };
    const calls: Call[] = [];
    const probed = await probeLima({ platform: "darwin", release: "25.0.0", env: { OMNIRUSH_BOX_LIMACTL: bin }, home, run: limaRun(state, { calls }) });
    expect(probed).toMatchObject({ ok: true, installed: true, state: "Stopped", version: "2.2.1", bin });
    expect(calls.find((c) => c.args[0] === "list")?.env?.LIMA_HOME).toBe(limaHome(home));
    mkdirSync(limaDir(home), { recursive: true });
    writeFileSync(path.join(limaDir(home), "failed.json"), JSON.stringify({ at: Date.now() - 60_000, reason: "vz: not supported" }));
    expect(await probeLima({ platform: "darwin", release: "25.0.0", env: { OMNIRUSH_BOX_LIMACTL: bin }, home, run: limaRun(state) })).toMatchObject({ ok: false, reason: expect.stringMatching(/did not start \(vz: not supported\)/) });
    expect((await probeLima({ platform: "darwin", release: "25.0.0", env: { OMNIRUSH_BOX_LIMACTL: bin }, home, run: limaRun(state), explicit: true })).ok).toBe(true);
    expect((await probeLima({ platform: "darwin", release: "25.0.0", env: { OMNIRUSH_BOX_LIMACTL: bin }, home, run: limaRun(state), now: Date.now() + 2 * 3_600_000 })).ok).toBe(true);
  });

  test("macOS order: under required the OmniRush VM first, even with OrbStack running; without required the order before the VM", async () => {
    const docker = "/usr/local/bin/docker";
    const run: RunCommand = async (_bin, args) => {
      if (args[0] === "context") return ok(JSON.stringify({ Name: "orbstack", DockerEndpoint: "unix:///x/orb.sock" }));
      if (args[0] === "--context") return ok({ OperatingSystem: "OrbStack", Name: "orbstack", ServerVersion: "27.0", OSType: "linux", Architecture: "aarch64" });
      return fail("no");
    };
    const base = { platform: "darwin" as const, arch: "arm64", release: "25.0.0", home: "/Users/sam", exists: (f: string) => f === docker, run, fresh: true };
    const vm = await detectBackend({ ...base, boxHome: tmp(), env: { PATH: "/usr/local/bin" }, all: true, required: true });
    expect(vm.ok && vm.backend).toBe("lima");
    expect(vm.alternatives?.some((a) => a.backend === "orbstack" && a.ok)).toBe(true);
    const old = await detectBackend({ ...base, boxHome: tmp(), release: "21.0.0", env: { PATH: "/usr/local/bin" }, required: true });
    expect(old.ok && old.backend).toBe("orbstack");
    // Not required: the order is the one before the VM (it runs only when chosen by name).
    const plain = await detectBackend({ ...base, boxHome: tmp(), env: { PATH: "/usr/local/bin" }, all: true });
    expect(plain.ok && plain.backend).toBe("orbstack");
    expect(plain.ok && plain.why).toBe("the first that works here, in order: orbstack > colima > docker-desktop > rancher > podman > docker");
    expect(plain.alternatives?.find((a) => a.backend === "lima")?.reason).toMatch(/used when the sandbox is required/);
    const none = await detectBackend({ ...base, boxHome: tmp(), env: { PATH: "/usr/bin" }, exists: () => false });
    expect(none.ok).toBe(false);
    expect(none.ok ? "" : none.reason).not.toMatch(/OmniRush VM/);
    const chosen = await detectBackend({ ...base, boxHome: tmp(), env: { PATH: "/usr/local/bin" }, asked: "lima" });
    expect(chosen.ok && chosen.backend).toBe("lima");
    expect(normalizeBackend("omnirush-vm")).toBe("lima");
    expect(runtimeBackend("/Applications/omnirush.app/Contents/Resources/sidecars/lima/bin/limactl")).toBe("lima");
    expect(driverFor({ backend: "lima" })).toBe(limaDriver);
    expect(limaDriver.shadows).toBe(true);
    expect(limaDriver.forwardsPorts).toBe(true);
    expect(limaDriver.pullCommand({ name: "lima", bin: "" }, { ref: "x", pull: "x", digest: null, stack: "base" } as never, "/h")).toBeNull();
  });
});

describe("lima: pins, paths, config (the same as the CLI's)", () => {
  test("Lima per arch by sha256; our VM image per arch by sha256, the official Debian one by sha512 when ours is not published", () => {
    const setup = loadDarwinSetup();
    expect(setup.backend).toBe("lima");
    expect(limaAsset(setup, "arm64")?.url).toMatch(/lima-2\.2\.1-Darwin-arm64\.tar\.gz$/);
    expect(limaAsset(setup, "x64")?.url).toMatch(/Darwin-x86_64/);
    const home = "/Users/sam/.omnirush/box";
    for (const [arch, name] of [["arm64", "arm64"], ["x64", "amd64"]] as const) {
      const ours = vmImage({ setup, arch, home, env: {} });
      expect(ours).toMatchObject({ kind: "custom", algo: "sha256", version: setup.vm?.image?.custom?.version });
      expect(ours?.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(ours?.url).toMatch(new RegExp(`^https://github\\.com/omnirush-ai/omnirush-gui/releases/download/box-[0-9.]+/omnirush-vm-[0-9.]+-${name}\\.qcow2$`));
      expect(path.dirname(String(ours?.file))).toBe(path.join(home, "lima", "images"));
    }
    const unpublished = { ...setup, vm: { ...setup.vm, image: { ...setup.vm?.image, custom: { version: null, arm64: { url: null, sha256: null }, x64: { url: null, sha256: null } } } } } as typeof setup;
    const image = vmImage({ setup: unpublished, arch: "arm64", home, env: {} });
    expect(image).toMatchObject({ kind: "debian", algo: "sha512" });
    expect(image?.url).toMatch(/genericcloud-arm64-.*\.qcow2$/);
    expect(path.dirname(String(image?.file))).toBe(path.join(home, "lima", "images"));
    expect(vmImage({ env: { OMNIRUSH_BOX_LIMA_IMAGE: "/tmp/vm.qcow2" } })?.file).toBe("/tmp/vm.qcow2");
  });

  test("limactl: the env's, else the one the app ships (sidecars/lima), else the CLI's or an earlier download in the shared box home", () => {
    const setup = loadDarwinSetup();
    const home = "/Users/sam/.omnirush/box";
    expect(findLimactl({ env: {}, home, exists: (f) => f === "/App/Resources/sidecars/lima/bin/limactl", setup, tools: "/App/Resources/sidecars" })).toEqual({ bin: "/App/Resources/sidecars/lima/bin/limactl", source: "bundled" });
    expect(findLimactl({ env: {}, home, exists: (f) => f === path.join(home, "lima", "dist", "2.2.1", "bin", "limactl"), setup, tools: null }).source).toBe("download");
    expect(findLimactl({ env: { OMNIRUSH_BOX_LIMACTL: "/x/limactl" }, home, exists: () => true, setup, tools: "/T" })).toEqual({ bin: "/x/limactl", source: "env" });
  });

  test("LIMA_HOME: <box home>/vm, ~/.omnirush-vm when that is too long for macOS' 104-byte sockets (the CLI's rule: one VM for both)", () => {
    expect(limaHome("/Users/sam/.omnirush/box", {}, "/Users/sam")).toBe("/Users/sam/.omnirush/box/vm");
    const deep = "/Users/sam/some/very/long/folder/for/the/box/home/.omnirush/box";
    expect(limaHome(deep, {}, "/Users/sam")).toBe("/Users/sam/.omnirush-vm");
    expect(limaHome(deep, { OMNIRUSH_BOX_LIMA_HOME: "/v" }, "/Users/sam")).toBe("/v");
    const { LIMA_HOME, LIMA_INSTANCE } = limaEnv("/h", { LIMA_INSTANCE: "default", LIMA_HOME: "/elsewhere" });
    expect({ LIMA_HOME, LIMA_INSTANCE }).toEqual({ LIMA_HOME: "/h/vm", LIMA_INSTANCE: undefined });
  });

  test("VM size and config: 3 GiB floor, vz, virtiofs, the home + /Volumes + /private/tmp writable at their paths", () => {
    const setup = loadDarwinSetup();
    expect(vmResources({ setup, cpus: 8, memBytes: 8 * GiB, env: {} })).toEqual({ cpus: 4, memory: 3, disk: 30 });
    expect(vmResources({ setup, cpus: 10, memBytes: 24 * GiB, env: {} })).toEqual({ cpus: 4, memory: 6, disk: 30 });
    expect(idleStopMinutes({ setup, env: {} })).toBe(30);
    const mounts = vmMounts({ userHome: "/Users/sam", extra: ["/Users/sam/x", "/opt/work/p"] });
    expect(mounts).toEqual(["/Users/sam", ...BASE_MOUNTS, "/opt/work/p"]);
    const config = vmConfig({ image: "/i.qcow2", arch: "arm64", cpus: 2, memory: 3, disk: 30, mounts }) as { vmType: string; mountType: string; arch: string; mounts: Array<{ writable: boolean; mountPoint: string; location: string }>; provision: Array<{ script: string }>; containerd: unknown };
    expect([config.vmType, config.mountType, config.arch]).toEqual(["vz", "virtiofs", LIMA_ARCH.arm64!]);
    expect(config.mounts.every((m) => m.writable && m.mountPoint === m.location)).toBe(true);
    expect(config.containerd).toEqual({ system: false, user: false });
    expect(config.provision[0]?.script).toBe(PROVISION);
    expect(uncovered(["/Users/sam/p", "/private/tmp/q", "/opt/a/b", "/opt/a/b/c", "rel"], ["/Users/sam", ...BASE_MOUNTS])).toEqual(["/opt/a/b"]);
  });

  test("the scripts the VM runs are the CLI's text (a VM made by either app is the same VM; sha256 pinned here, checked against the CLI's in the evidence)", () => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
    expect({ provision: sha(PROVISION), helpers: sha(HELPER_SCRIPT) }).toEqual({ provision: "113559f9703cd87e", helpers: "4a5ed8fc2e5f40b1" });
  });
});

describe("lima: one VM for the CLI and the desktop", () => {
  test("owner lock: one holder; a dead holder's lock is taken over; a live one makes the next wait, then give up", async () => {
    const home = tmp();
    const release = await lockVm(home, { waitMs: 0 });
    expect(release).toBeTruthy();
    const t = { now: 0 };
    expect(await lockVm(home, { waitMs: 1_000, sleep: async (ms) => { t.now += ms; }, now: () => t.now })).toBeNull();
    release!();
    mkdirSync(limaDir(home), { recursive: true });
    writeFileSync(path.join(limaDir(home), "vm.lock"), JSON.stringify({ pid: DEAD, nonce: "x", at: 1 }));
    const taken = await lockVm(home, { waitMs: 0, pidAlive: (pid) => pid !== DEAD });
    expect(taken).toBeTruthy();
    taken!();
    expect(existsSync(path.join(limaDir(home), "vm.lock"))).toBe(false);
  });

  test("leases: the CLI's file format (pid, started, key, client, at); a gone process' lease is dropped", () => {
    const home = tmp();
    const release = takeLease(home, "k1");
    takeLease(home, "k2", { pid: DEAD, client: "cli" });
    const file = readdirSync(path.join(limaDir(home), "leases")).find((n) => n.startsWith("k1-"))!;
    expect(file).toMatch(new RegExp(`^k1-${process.pid}-\\d+\\.json$`));
    expect(Object.keys(JSON.parse(readFileSync(path.join(limaDir(home), "leases", file), "utf8"))).sort()).toEqual(["at", "client", "key", "pid", "started"]);
    const live = liveLeases(home, { pidAlive: (pid) => pid !== DEAD });
    expect(live.map((l) => [l.key, l.client])).toEqual([["k1", "desktop"]]);
    expect(readdirSync(path.join(limaDir(home), "leases")).length).toBe(1);
    release();
    expect(liveLeases(home)).toEqual([]);
  });

  test("idle stop: busy while a lease lives; stopped after the idle time with none, under the lock; done when the VM is stopped", async () => {
    const home = tmp();
    const bin = fakeLimactl(home);
    const state: VmState = { status: "Running" };
    const runtime = { bin, home, instance: "omnirush-box" };
    const release = takeLease(home, "k");
    expect(await idleStep(runtime, { busyAt: 0, now: 10_000_000, idleMs: 60_000, run: limaRun(state) })).toEqual({ busyAt: 10_000_000 });
    release();
    expect(await idleStep(runtime, { busyAt: 10_000_000, now: 10_030_000, idleMs: 60_000, run: limaRun(state) })).toEqual({ busyAt: 10_000_000 });
    expect((await idleStep(runtime, { busyAt: 10_000_000, now: 10_060_000, idleMs: 60_000, run: limaRun(state) })).stop).toBe(true);
    const again = takeLease(home, "k");
    expect(await stopIfIdle(runtime, { run: limaRun(state) })).toEqual({ stopped: false, reason: "busy" });
    again();
    expect(await stopIfIdle(runtime, { run: limaRun(state) })).toEqual({ stopped: true });
    expect(state.status).toBe("Stopped");
    expect((await idleStep(runtime, { busyAt: 0, now: 1, idleMs: 60_000, run: limaRun(state) })).done).toBe(true);
  });

  test("the idle watcher for real: started once (idle.json), stops a VM with no lease after the idle time and ends", async () => {
    const home = tmp();
    const log = path.join(home, "limactl.log");
    const bin = path.join(home, "limactl");
    // A limactl that says the VM runs until it is stopped.
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${log}\ncase "$*" in\n  *stop*) touch ${home}/stopped; exit 0;;\n  list*) [ -f ${home}/stopped ] && echo '{"name":"omnirush-box","status":"Stopped"}' || echo '{"name":"omnirush-box","status":"Running"}'; exit 0;;\nesac\nexit 0\n`, { mode: 0o755 });
    const runtime = { home, bin, instance: "omnirush-box" };
    const script = idleMain();
    expect(script).toMatch(/lima-idle\.(ts|js)$/);
    const env = { ...process.env, OMNIRUSH_BOX_LIMA_IDLE_MIN: "0.02" };
    const pid = keepIdleWatch(runtime, { env, spawnImpl: spawn as unknown as SpawnLike });
    expect(pid).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(path.join(limaDir(home), "idle.json"), "utf8")).pid).toBe(pid);
    expect(keepIdleWatch(runtime, { env, spawnImpl: () => { throw new Error("a second watcher"); } })).toBe(pid);
    for (let i = 0; i < 100 && !existsSync(path.join(home, "stopped")); i += 1) await sleep(100);
    expect(readFileSync(log, "utf8")).toMatch(/--tty=false stop omnirush-box/);
    expect(existsSync(path.join(limaDir(home), "vm.lock"))).toBe(false);
  }, 20_000);

  test("contract: client desktop; same is used, an older VM is kept (never replaced under a box), a newer client's VM is used as it is", () => {
    const c = contractFor({ kind: "debian", version: "v", digest: "ab", algo: "sha512" }, { clientVersion: "3.8.0", lima: "2.2.1" });
    expect(c).toMatchObject({ contract: VM_CONTRACT, client: "desktop", client_version: "3.8.0", lima: "2.2.1", image: { kind: "debian", version: "v", digest: "sha512:ab" } });
    expect(Object.keys(c).sort()).toEqual(["client", "client_version", "contract", "created_at", "image", "lima"]);
    expect(contractVerdict({ contract: VM_CONTRACT })).toBe("use");
    expect(contractVerdict(null)).toBe("use");
    expect(contractVerdict({ contract: VM_CONTRACT - 1 })).toBe("replace");
    expect(contractVerdict({ contract: VM_CONTRACT + 1 })).toBe("newer");
  });
});

describe("lima: limactl calls", () => {
  test("commands in the VM: root, no shell in between; a VM that went away (sleep) is started and the call tried once more", async () => {
    const runtime: LimaRuntime = { bin: "/x/limactl", home: "/h", instance: "omnirush-box" };
    expect(inVm(runtime, ["/opt/omnirush/boxrun", "status"])).toEqual(["shell", "--workdir", "/", "omnirush-box", "sudo", "-n", "/opt/omnirush/boxrun", "status"]);
    expect(vmAway(fail("ssh: connect to host 127.0.0.1 port 50022: Connection refused", 255))).toBe(true);
    expect(vmAway(fail("boxrun: image x is not unpacked"))).toBe(false);
    let n = 0;
    let ensured = 0;
    const res = await vmCall(runtime, ["true"], { run: async () => (++n === 1 ? fail("kex_exchange_identification: read: Connection reset by peer", 255) : ok("fine")), ensure: async () => { ensured += 1; return { ok: true }; } });
    expect({ code: res.code, n, ensured }).toEqual({ code: 0, n: 2, ensured: 1 });
    // Listed as running, but its sshd resets every connection: stopped once (no box runs), started again, the call passes.
    const home = tmp();
    const vm = { status: "Running", sshDead: true, stops: 0 };
    const dead: RunCommand = async (_bin, args) => {
      if (args.includes("stop")) { vm.stops += 1; vm.status = "Stopped"; vm.sshDead = false; return ok(""); }
      if (args[0] === "shell") return vm.sshDead || vm.status !== "Running" ? fail("kex_exchange_identification: read: Connection reset by peer", 255) : ok("in");
      return fail("unexpected");
    };
    const lock = async () => () => {};
    const startIt = async () => { vm.status = "Running"; return { ok: true }; };
    const healed = await vmCall({ ...runtime, home }, ["true"], { run: dead, ensure: startIt, sleep: async () => {}, lock });
    expect({ code: healed.code, stops: vm.stops }).toEqual({ code: 0, stops: 1 });
    // Never while another app's box holds a lease: the error stays (the box keeps running).
    Object.assign(vm, { sshDead: true, stops: 0 });
    takeLease(home, "other-box", { pid: process.ppid, client: "cli" });
    const kept = await vmCall({ ...runtime, home }, ["true"], { run: dead, ensure: startIt, sleep: async () => {}, lock });
    expect({ code: kept.code, stops: vm.stops }).toEqual({ code: 255, stops: 0 });
    expect(limaError(fail('time="2026" level=fatal msg="failed to start: \\"vz\\" requires macOS 13"'))).toBe('failed to start: "vz" requires macOS 13');
    const gone = await vmRow(runtime, { run: async () => fail('level=warning msg="No instance matching omnirush-box found."\nlevel=fatal msg="unmatched instances"') });
    expect({ row: gone.row, missing: gone.missing }).toEqual({ row: null, missing: true });
    expect(parseList(`${JSON.stringify({ name: "other" })}\n${JSON.stringify({ name: "omnirush-box", status: "Running" })}\n`, "omnirush-box")?.status).toBe("Running");
  });

  test("downloads: checked by digest (sha256 or sha512); a stall is tried again; byte progress is passed on", async () => {
    const dir = tmp();
    const body = Buffer.from("vm image");
    const sha512 = createHash("sha512").update(body).digest("hex");
    let fetched = 0;
    const seen: Array<[number, number | null]> = [];
    const fetchFile = async (_url: string, dest: string, _sha: string | null, opts?: { onProgress?: (d: number, t: number | null) => void }) => { fetched += 1; opts?.onProgress?.(body.length, body.length); writeFileSync(dest, body); return dest; };
    const dest = path.join(dir, "img.qcow2");
    await fetchChecked("https://x/img", dest, { algo: "sha512", digest: sha512, fetchFile, onProgress: (d, t) => seen.push([d, t]) });
    await fetchChecked("https://x/img", dest, { algo: "sha512", digest: sha512, fetchFile });
    expect(fetched).toBe(1);
    expect(seen).toEqual([[8, 8]]);
    await expect(fetchChecked("https://x/img", path.join(dir, "bad"), { algo: "sha512", digest: "0".repeat(128), fetchFile })).rejects.toThrow(/sha512 mismatch/);
    let calls = 0;
    const flaky = async (_url: string, d: string) => { calls += 1; if (calls < 3) throw new Error("download: no data for 90 s"); writeFileSync(d, body); return d; };
    await fetchChecked("https://x/img", path.join(dir, "flaky"), { algo: "sha512", digest: sha512, fetchFile: flaky });
    expect(calls).toBe(3);
  });

  test("Lima itself: the pinned tarball, sha256-checked, unpacked to the shared box home (the CLI's place) with limactl and the Linux guest agent only", async () => {
    const home = tmp();
    const src = tmp();
    for (const f of ["bin/limactl", "bin/docker.lima", "libexec/lima/lima-driver-qemu", "share/lima/lima-guestagent.Linux-aarch64.gz", "share/lima/lima-guestagent.Darwin-aarch64.gz", "share/lima/templates/default.yaml"]) {
      mkdirSync(path.join(src, path.dirname(f)), { recursive: true });
      writeFileSync(path.join(src, f), f);
    }
    const tarball = path.join(tmp(), "lima.tar.gz");
    execFileSync("tar", ["-czf", tarball, "-C", src, "bin", "libexec", "share"]);
    const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    const setup = { lima: { version: "2.2.1", assets: { arm64: { url: "https://x/lima.tar.gz", sha256 } } } };
    const runtime: LimaRuntime = { bin: "", home, instance: "omnirush-box" };
    const run: RunCommand = async (_bin, args) => { try { execFileSync("tar", args); return ok(""); } catch (e) { return fail(String(e)); } };
    const lines: string[] = [];
    const got = await ensureLimactl(runtime, { arch: "arm64", setup, run, fetchFile: async (_url, dest, _s, opts) => { opts?.onProgress?.(10, 20); writeFileSync(dest, readFileSync(tarball)); return dest; }, onLine: (_s, l) => lines.push(l) });
    expect(got.ok).toBe(true);
    const dist = path.join(limaDir(home), "dist", "2.2.1");
    expect(runtime.bin).toBe(path.join(dist, "bin", "limactl"));
    expect(readdirSync(path.join(dist, "bin"))).toEqual(["limactl"]);
    expect(readdirSync(path.join(dist, "share", "lima")).sort()).toEqual(["lima-guestagent.Linux-aarch64.gz", "templates"]);
    expect(lines).toEqual([setupLine("lima"), setupLine("lima", 10, 20)]);
  });
});

describe("lima: two apps at once, reused pids", () => {
  test("first setup at once (CLI and desktop): two downloads of one file never share a part file; a finished copy is a success", async () => {
    const dir = tmp();
    const body = Buffer.from("vm image body");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const dest = path.join(dir, "img.qcow2");
    const parts: string[] = [];
    const slow = async (_url: string, part: string) => {
      parts.push(part);
      for (let i = 0; i < body.length; i += 4) {
        writeFileSync(part, body.subarray(0, i + 4));
        await new Promise((r) => setTimeout(r, 2));
      }
      return part;
    };
    const [a, b] = await Promise.all([fetchChecked("https://x/img", dest, { digest: sha256, fetchFile: slow }), fetchChecked("https://x/img", dest, { digest: sha256, fetchFile: slow })]);
    expect([a, b]).toEqual([dest, dest]);
    expect(parts[0]).not.toBe(parts[1]);
    expect(readFileSync(dest)).toEqual(body);
    expect(readdirSync(dir)).toEqual(["img.qcow2"]);
    const other = path.join(dir, "other.qcow2");
    expect(await fetchChecked("https://x/img", other, { digest: sha256, fetchFile: async () => { writeFileSync(other, body); throw new Error("download: HTTP 404"); } })).toBe(other);
  });

  test("Lima itself, two apps at once: both end with the one unpacked limactl", async () => {
    const home = tmp();
    const src = tmp();
    for (const f of ["bin/limactl", "share/lima/lima-guestagent.Linux-aarch64.gz"]) {
      mkdirSync(path.join(src, path.dirname(f)), { recursive: true });
      writeFileSync(path.join(src, f), f);
    }
    const tarball = path.join(tmp(), "lima.tar.gz");
    execFileSync("tar", ["-czf", tarball, "-C", src, "bin", "share"]);
    const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    const setup = { lima: { version: "2.2.1", assets: { arm64: { url: "https://x/lima.tar.gz", sha256 } } } };
    const run: RunCommand = async (_bin, args) => { await new Promise((r) => setTimeout(r, 5)); try { execFileSync("tar", args); return ok(""); } catch (e) { return fail(String(e)); } };
    const fetchFile = async (_url: string, dest: string) => { await new Promise((r) => setTimeout(r, 5)); writeFileSync(dest, readFileSync(tarball)); return dest; };
    const one: LimaRuntime = { bin: "", home, instance: "omnirush-box" };
    const two: LimaRuntime = { bin: "", home, instance: "omnirush-box" };
    const got = await Promise.all([ensureLimactl(one, { arch: "arm64", setup, run, fetchFile }), ensureLimactl(two, { arch: "arm64", setup, run, fetchFile })]);
    expect(got.map((g) => g.ok)).toEqual([true, true]);
    const bin = path.join(limaDir(home), "dist", "2.2.1", "bin", "limactl");
    expect([one.bin, two.bin]).toEqual([bin, bin]);
    expect(readdirSync(path.join(limaDir(home), "dist"))).toEqual(["2.2.1"]);
  });

  test("owner lock: a stale lock is cleared through a name of its own (a lock taken meanwhile stays); a reused pid is not the holder", async () => {
    const home = tmp();
    mkdirSync(limaDir(home), { recursive: true });
    const file = path.join(limaDir(home), "vm.lock");
    writeFileSync(file, JSON.stringify({ pid: DEAD, nonce: "old", at: 1 }));
    const stale = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ pid: process.pid, nonce: "new", at: 2 }));
    expect(clearStale(file, stale)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).nonce).toBe("new");
    expect(readdirSync(limaDir(home))).toEqual(["vm.lock"]);
    writeFileSync(file, JSON.stringify({ pid: DEAD, nonce: "old", at: 1 }));
    expect(clearStale(file, stale)).toBe(true);
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, JSON.stringify({ pid: process.pid, started: 1_000, nonce: "reused", at: 1 }));
    const taken = await lockVm(home, { waitMs: 0 });
    expect(taken).toBeTruthy();
    const mine = JSON.parse(readFileSync(file, "utf8"));
    expect([mine.pid, mine.started]).toEqual([process.pid, selfStart()]);
    taken!();
    expect(alive(process.pid, selfStart())).toBe(true);
    expect(alive(process.pid, null)).toBe(true);
    expect(alive(process.pid, 1_000, { start: () => 99_000 })).toBe(false);
  });

  test("leases and the idle watcher keep the process start time; a lease whose pid was reused is dropped", () => {
    const home = tmp();
    const release = takeLease(home, "k1");
    takeLease(home, "k2", { pid: process.pid, started: 1_000 });
    expect(liveLeases(home).map((l) => l.key)).toEqual(["k1"]);
    release();
    let spawned = 0;
    const spawnImpl = (() => { spawned += 1; return { pid: process.pid, unref() {} }; }) as unknown as SpawnLike;
    const rt = { home, bin: "/x/limactl", instance: "omnirush-box" };
    expect(keepIdleWatch(rt, { env: { OMNIRUSH_BOX_LIMA_IDLE_MIN: "30" }, spawnImpl, script: "/x/lima-idle.js" })).toBe(process.pid);
    expect(JSON.parse(readFileSync(path.join(limaDir(home), "idle.json"), "utf8")).started).toBe(selfStart());
    writeFileSync(path.join(limaDir(home), "idle.json"), JSON.stringify({ pid: process.pid, started: 1_000 }));
    keepIdleWatch(rt, { env: { OMNIRUSH_BOX_LIMA_IDLE_MIN: "30" }, spawnImpl, script: "/x/lima-idle.js" });
    expect(spawned).toBe(2);
  });
});

function vmFixture({ status = null, mounts }: { status?: string | null; mounts?: string[] } = {}) {
  const home = tmp();
  const bin = fakeLimactl(home);
  const image = path.join(home, "vm.qcow2");
  writeFileSync(image, "qcow2");
  const env = { OMNIRUSH_BOX_LIMA_IMAGE: image, PATH: "/usr/bin" };
  const state: VmState = { status, ...(mounts ? { mounts } : {}), wantMounts: ["/Users/sam", ...BASE_MOUNTS] };
  const shells: Array<{ argv: string[]; input?: string | Buffer | undefined }> = [];
  const calls: Call[] = [];
  const run = limaRun(state, { calls, onShell: (argv, opts) => { shells.push({ argv, input: opts.input }); return argv[0] === "cat" ? ok(JSON.stringify({ contract: VM_CONTRACT })) : ok(""); } });
  const spawned: string[][] = [];
  const spawnImpl = ((_bin: string, args: string[]) => { spawned.push(args); return { pid: DEAD, unref() {} }; }) as unknown as SpawnLike;
  return { home, bin, env, state, shells, calls, run, spawnImpl, spawned, runtime: { bin, home, instance: "omnirush-box", arch: "arm64" } as LimaRuntime };
}

describe("lima: the VM's life", () => {
  test("first use: the VM made from the config file, its contract written (client desktop), the idle watcher started, setup lines said", async () => {
    const f = vmFixture();
    const lines: string[] = [];
    const res = await ensureVm(f.runtime, { env: f.env, run: f.run, paths: ["/Users/sam/proj"], userHome: "/Users/sam", spawnImpl: f.spawnImpl, resources: { cpus: 2, memory: 3, disk: 30 }, clientVersion: "3.8.0", onLine: (_s, l) => lines.push(l) });
    expect(res.ok).toBe(true);
    const start = f.calls.find((c) => c.args.includes("start"))!;
    expect(start.args.slice(0, 4)).toEqual(["--tty=false", "start", "--name", "omnirush-box"]);
    const config = JSON.parse(readFileSync(start.args.at(-1)!, "utf8").replace(/^#.*\n/, ""));
    expect(config.vmType).toBe("vz");
    expect(config.images[0].location).toBe(f.env.OMNIRUSH_BOX_LIMA_IMAGE);
    const contract = f.shells.find((s) => /vm\.json/.test(s.argv.join(" ")) && s.input);
    expect(JSON.parse(String(contract?.input))).toMatchObject({ contract: VM_CONTRACT, client: "desktop", client_version: "3.8.0", image: { kind: "local" } });
    expect(f.spawned.some((args) => args.some((a) => /lima-idle\.(ts|js)$/.test(a)))).toBe(true);
    expect(existsSync(path.join(limaDir(f.home), "vm.lock"))).toBe(false);
    expect(lines).toEqual([setupLine("vm_boot")]);
    f.calls.length = 0;
    const again = await ensureVm(f.runtime, { env: f.env, run: f.run, paths: ["/Users/sam/proj"], userHome: "/Users/sam", spawnImpl: f.spawnImpl });
    expect(again).toMatchObject({ ok: true, started: false });
    expect(f.calls.some((c) => c.args.includes("start"))).toBe(false);
  });

  test("a stopped VM is started; one that cannot start says why and is not picked again for a while", async () => {
    const f = vmFixture({ status: "Stopped", mounts: ["/Users/sam", ...BASE_MOUNTS] });
    expect((await ensureVm(f.runtime, { env: f.env, run: f.run, paths: ["/Users/sam/p"], spawnImpl: f.spawnImpl })).ok).toBe(true);
    expect(f.state.status).toBe("Running");
    const g = vmFixture({ status: "Stopped", mounts: ["/Users/sam"] });
    g.state.startFails = "vz: Virtualization is not available on this hardware";
    const res = await ensureVm(g.runtime, { env: g.env, run: g.run, paths: ["/Users/sam/p"], spawnImpl: g.spawnImpl });
    expect(res.ok).toBe(false);
    expect(readFileSync(path.join(limaDir(g.home), "failed.json"), "utf8")).toMatch(/Virtualization/);
  });

  test("a project outside the shared folders: added with one VM restart, never while another app's box runs", async () => {
    const f = vmFixture({ status: "Running", mounts: ["/Users/sam", ...BASE_MOUNTS] });
    const lease = takeLease(f.home, "other", { pid: process.ppid || 1, client: "cli" });
    const busy = await ensureVm(f.runtime, { env: f.env, run: f.run, paths: ["/opt/work/p"], spawnImpl: f.spawnImpl });
    expect(busy).toMatchObject({ ok: false, error: expect.stringMatching(/outside the folders the sandbox VM shares/) });
    expect(f.state.status).toBe("Running");
    lease();
    expect((await ensureVm(f.runtime, { env: f.env, run: f.run, paths: ["/opt/work/p"], spawnImpl: f.spawnImpl })).ok).toBe(true);
    expect(f.state.mounts).toEqual(["/Users/sam", ...BASE_MOUNTS, "/opt/work/p"]);
  });

  test("helpers: this install's boxrun/boxd in its own folder in the VM (the CLI's never swapped), staged via the box home", async () => {
    const f = vmFixture({ status: "Running", mounts: ["/Users/sam"] });
    const bins = tmp();
    mkdirSync(path.join(bins, "linux-arm64"), { recursive: true });
    for (const n of ["boxrun", "boxd"]) writeFileSync(path.join(bins, "linux-arm64", n), n);
    const res = await syncHelpers(f.runtime, { env: { OMNIRUSH_BOX_BIN_DIR: bins }, run: f.run });
    expect(res.ok && res.dir).toMatch(/^\/opt\/omnirush\/h\/[0-9a-f]{16}$/);
    const call = f.shells.at(-1)!.argv;
    expect(call.slice(0, 3)).toEqual(["/bin/sh", "-c", HELPER_SCRIPT]);
    expect(readFileSync(path.join(call.at(-1)!, "boxd"), "utf8")).toBe("boxd");
  });
});

function fakeChild(line: string | null) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; exitCode: number | null; kill: () => void; unref: () => void };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; setImmediate(() => child.emit("close", 0)); };
  child.unref = () => {};
  if (line) setTimeout(() => child.stdout.write(`${line}\n`), 5);
  return child;
}

describe("lima: boxes", () => {
  test("keeper: `limactl shell ... sudo boxrun up --foreground`, the first JSON line gives the port; a keeper that lost the VM says so", async () => {
    let seen: { args: string[]; env?: NodeJS.ProcessEnv } | null = null;
    const kept = await startKeeper({ bin: "/x/limactl", home: "/h", instance: "omnirush-box", helpers: "/opt/omnirush/h/abc" }, ["up"], {
      spawnImpl: ((_bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => { seen = { args, env: opts.env }; return fakeChild('{"ok":true,"reused":false,"port":40123}'); }) as unknown as SpawnLike, timeoutMs: 2_000,
    });
    expect(kept.ok && kept.out.port).toBe(40123);
    expect(seen!.args.slice(0, 7)).toEqual(["shell", "--workdir", "/", "omnirush-box", "sudo", "-n", "/opt/omnirush/h/abc/boxrun"]);
    expect(seen!.env?.LIMA_HOME).toBe("/h/vm");
    const lost = await startKeeper({ bin: "/x/limactl", home: "/h", instance: "omnirush-box" }, ["up"], {
      spawnImpl: (() => { const c = fakeChild(null); setTimeout(() => { c.stderr.write("ssh: connect to host 127.0.0.1 port 5022: Connection refused\n"); c.emit("close", 255); }, 5); return c; }) as unknown as SpawnLike, timeoutMs: 2_000,
    });
    expect(lost).toMatchObject({ ok: false, away: true });
  });

  test("a box start: the VM ensured, the box up on a loopback port free on this Mac, a lease (client desktop) while the keeper lives", async () => {
    const f = vmFixture({ status: "Running", mounts: ["/Users/sam", ...BASE_MOUNTS] });
    const bins = tmp();
    mkdirSync(path.join(bins, "linux-arm64"), { recursive: true });
    for (const n of ["boxrun", "boxd"]) writeFileSync(path.join(bins, "linux-arm64", n), n);
    const root = "/Users/sam/proj";
    const runFolder = path.join(f.home, "projects", "k");
    mkdirSync(runFolder, { recursive: true });
    const image = { ref: "omnirush/box-base:1", pull: `ghcr.io/x/box-base@sha256:${"b".repeat(64)}`, digest: `sha256:${"b".repeat(64)}`, stack: "base" };
    const run = limaRun(f.state, { calls: f.calls, onShell: (argv) => (argv.includes("image") ? ok('{"present":true,"id":"img1","digest":"sha256:bb","arch":"arm64","config":"cfg"}') : ok("")) });
    let child: ReturnType<typeof fakeChild> | null = null;
    let up: string[] = [];
    const opened = await limaDriver.open({
      key: "k", name: "omnirush-box-k", root, croot: root, runtime: { ...f.runtime, name: "lima", backend: "lima" }, run, home: f.home, runFolder, image: image as never, pull: false, shims: null, pkglog: null,
      env: { ...f.env, OMNIRUSH_BOX_BIN_DIR: bins }, platform: "darwin", log: () => {}, onPulling: () => {},
      shadows: { binds: [{ id: "0123456789ab", path: "node_modules", target: `${root}/node_modules` }], env: {} } as never,
      spawnImpl: ((_bin: string, args: string[]) => { up = args; child = fakeChild('{"ok":true,"reused":false,"port":41999}'); return child; }) as unknown as SpawnLike,
      idleSpawn: f.spawnImpl, freePort: async () => 41999,
    } as never);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.endpoint.port).toBe(41999);
    expect(up).toContain("BOXD_LISTEN=127.0.0.1:41999");
    expect(up).toContain(`${root}=${root}`);
    expect(up[up.indexOf("--shadow-store") + 1]).toBe("/var/lib/omnirush/shadows/k");
    expect(liveLeases(f.home).map((l) => [l.key, l.client])).toEqual([["k", "desktop"]]);
    expect((await limaDriver.list({ ...f.runtime, name: "lima" }, { home: f.home }))[0]?.running).toBe(true);
    child!.kill();
    await sleep(20);
    expect(liveLeases(f.home)).toEqual([]);
  });

  test("sandbox shell: limactl with the box home's LIMA_HOME, root in the box at the project", () => {
    const cmd = limaDriver.shellCommand({ name: "lima", bin: "/x/limactl", home: "/h", instance: "omnirush-box" }, { key: "k", croot: "/Users/sam/p", home: "/h" });
    expect(cmd.bin).toBe("/usr/bin/env");
    expect(cmd.args.slice(0, 3)).toEqual(["LIMA_HOME=/h/vm", "/x/limactl", "shell"]);
    expect(cmd.args.slice(-8)).toEqual(["enter", "--box", "/var/lib/omnirush/boxes/k", "--wd", "/Users/sam/p", "--", "/bin/bash", "-l"]);
  });
});

describe("lima: the first setup's progress and the wait for it", () => {
  test("setup lines: the step the VM setup is at, with that step's bytes; the image's own bytes after it", () => {
    const text = [setupLine("lima"), setupLine("lima", 1_000, 38_000_000), setupLine("vm_image"), setupLine("vm_image", 84_000_000, 336_000_000)].join("\n");
    expect(parseSetupLines(text)).toEqual({ step: "vm_image", bytesDone: 84_000_000, bytesTotal: 336_000_000, seen: ["lima", "vm_image"] });
    expect(parseSetupLines(`${text}\n${setupLine("vm_boot")}`)).toEqual({ step: "vm_boot", bytesDone: null, bytesTotal: null, seen: ["lima", "vm_image", "vm_boot"] });
    expect(parseSetupLines('{"progress":{"bytes":1,"total":2}}')).toBeNull();
    const dir = tmp();
    const marker = path.join(dir, "pulls", "lima-x.pid");
    const progress = inProcessLog(marker);
    progress.onLine("stdout", setupLine("vm_image", 10, 100));
    expect(pullProgress(pullLog(marker), marker, null)).toMatchObject({ bytesDone: null, bytesTotal: null, setup: { step: "vm_image", bytesDone: 10, bytesTotal: 100 } });
    progress.onLine("stdout", setupLine("image"));
    progress.onLine("stderr", '{"progress":{"bytes":50,"total":200}}');
    expect(pullProgress(pullLog(marker), marker, null)).toMatchObject({ bytesDone: 50, bytesTotal: 200, setup: { step: "image" } });
    progress.close();
    expect(existsSync(marker)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the required wait goes on while the setup moves, stops after the no-progress time or the cap", () => {
    const base = { startedAt: 0, idleMs: 15 * 60_000, maxMs: 60 * 60_000 };
    expect(setupWait({ ...base, lastProgressAt: 0, now: 14 * 60_000 }).over).toBeNull();
    expect(setupWait({ ...base, lastProgressAt: 0, now: 15 * 60_000 }).over).toBe("idle");
    expect(setupWait({ ...base, lastProgressAt: 40 * 60_000, now: 50 * 60_000 }).over).toBeNull();
    expect(setupWait({ ...base, lastProgressAt: 59 * 60_000, now: 60 * 60_000 }).over).toBe("max");
  });
});
