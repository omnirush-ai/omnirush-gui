// Ported from the CLI (omnirush-cli test/box-required.test.js, the shadow
// tests): on a macOS or Windows host a box on a backend whose boxrun runs as
// root (the WSL distro) gets its own Linux copy of each build folder. The
// plan (required.json shadows), boxrun's arguments, the env redirections, the
// plan boxd reads for folders made mid-chat, the agent's line, record.json,
// and that shadows are never in a snapshot. No runtime is touched.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectBackend, driverFor } from "./backends/index.js";
import { upArgs } from "./backends/bwrap.js";
import { Box, dependencyFolders, recordFile } from "./box.js";
import { boxShadows } from "./launch.js";
import { BOX_NOTE } from "./plugin-lib.js";
import { REQUIRED_RULES, shadowId, shadowPlan, shadowRecord, shadowsApply, shadowsNotice } from "./required.js";
import type { RunCommand } from "./run.js";

const dirs: string[] = [];
const tmp = (name: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `box-shadow-${name}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const down: RunCommand = async () => ({ code: 1, stdout: "", stderr: "not here" });
const store = REQUIRED_RULES.shadows.store;

describe("build-artefact shadows: the plan", () => {
  test("node_modules even if absent, existing build folders, env redirections; nothing on Linux", () => {
    const root = tmp("plan");
    writeFileSync(path.join(root, "package.json"), "{}");
    writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname='x'\n");
    writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname='x'\n");
    mkdirSync(path.join(root, ".venv"));
    writeFileSync(path.join(root, ".venv", "pyvenv.cfg"), "home = /opt/homebrew/bin\n");
    mkdirSync(path.join(root, ".next"));
    mkdirSync(path.join(root, "packages", "web", "node_modules"), { recursive: true });
    writeFileSync(path.join(root, "packages", "web", "package.json"), "{}");
    mkdirSync(path.join(root, "packages", "lib"), { recursive: true });
    writeFileSync(path.join(root, "packages", "lib", "package.json"), "{}");
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist", "readme.txt"), "source, not a build");
    const plan = shadowPlan(root, { platform: "darwin", croot: root });
    const byPath = Object.fromEntries(plan.binds.map((b) => [b.path, b]));
    expect(Object.keys(byPath).sort()).toEqual([".next", ".venv", "node_modules", "packages/lib/node_modules", "packages/web/node_modules"]);
    expect(byPath.node_modules!.existed).toBe(false);
    expect(byPath["packages/web/node_modules"]!.existed).toBe(true);
    expect(byPath.node_modules!.target).toBe(`${root}/node_modules`);
    expect(byPath.node_modules!.id).toBe(createHash("sha256").update("node_modules").digest("hex").slice(0, 12));
    expect(plan.env.UV_PROJECT_ENVIRONMENT).toBe(`${store}/${shadowId(".")}/venv`);
    expect(plan.env.CARGO_TARGET_DIR).toBe(`${store}/${shadowId(".")}/cargo-target`);
    expect(plan.env.POETRY_VIRTUALENVS_PATH).toBeUndefined();
    expect(shadowRecord(plan)!.binds.find((b) => b.path === "node_modules")).toEqual({ path: "node_modules", existed: false });
    // The desktop's words (texts.desktop.shadows) on the card; the CLI's (texts.cli.shadows) for the agent.
    expect(shadowsNotice(plan, "darwin")).toMatch(/^In the sandbox, node_modules, \.venv, \.next(, target)? are the sandbox's own Linux copies; your Mac copies are left as they are\.$/);
    expect(shadowsNotice(plan, "darwin", "cli")).toMatch(/your Mac copies are left as they are\. Install dependencies inside as needed\.$/);
    // Windows: the same rules, with the folder as the box sees it (/c/...).
    const win = shadowPlan(root, { platform: "win32", croot: "/c/Users/u/proj" });
    expect(win.binds.find((b) => b.path === "node_modules")!.target).toBe("/c/Users/u/proj/node_modules");
    expect(shadowsNotice(win, "win32")).toMatch(/your Windows copies are left as they are\.$/);
    expect(shadowPlan(root, { platform: "linux" }).binds.length).toBe(0);
    expect(shadowsApply("darwin", { OMNIRUSH_BOX_SHADOWS: "off" })).toBe(false);
    expect(shadowsApply("linux", {})).toBe(false);
    expect(shadowsNotice(shadowPlan(root, { platform: "linux" }), "linux")).toBeNull();
  });

  test("store ids: sha256 of the project-relative POSIX path, 12 hex digits, \".\" for the root (boxd computes the same)", () => {
    expect(shadowId(".")).toBe(createHash("sha256").update(".").digest("hex").slice(0, 12));
    expect(shadowId("")).toBe(shadowId("."));
    expect(shadowId("packages\\web\\node_modules")).toBe(shadowId("packages/web/node_modules"));
    expect(shadowId("./a//b/")).toBe(shadowId("a/b"));
  });

  test("a Mac program in dist/ shadows dist; the scan stays within its limits", () => {
    const root = tmp("dist");
    mkdirSync(path.join(root, "dist"));
    const macho = Buffer.alloc(64);
    macho.writeUInt32BE(0xcffaedfe, 0);
    writeFileSync(path.join(root, "dist", "app"), macho, { mode: 0o755 });
    expect(shadowPlan(root, { platform: "darwin", croot: root }).binds.map((b) => b.path)).toEqual(["dist"]);
    const deep = tmp("deep");
    let dir = deep;
    for (let i = 0; i < 8; i += 1) { dir = path.join(dir, `d${i}`); mkdirSync(dir); writeFileSync(path.join(dir, "package.json"), "{}"); }
    expect(shadowPlan(deep, { platform: "darwin", croot: deep }).binds.length).toBe(REQUIRED_RULES.shadows.limits.depth);
  });
});

describe("build-artefact shadows: the backends", () => {
  test("upArgs: shadows go to boxrun as a store and ID=DST pairs (only when asked)", () => {
    const base = { box: "/b", store: "/s", image: "i", boxd: "/d", portFile: "/p", root: "/r", croot: "/r", runFolder: "/run", token: "t" };
    expect(upArgs(base).includes("--shadow-store")).toBe(false);
    const args = upArgs({ ...base, shadows: { binds: [{ path: "node_modules", existed: false, id: "0123456789ab", target: "/r/node_modules" }] }, shadowStore: "/var/lib/omnirush/shadows/k" });
    expect(args.slice(args.indexOf("--shadow-store"))).toEqual(["--shadow-store", "/var/lib/omnirush/shadows/k", "--shadow", "0123456789ab=/r/node_modules", "--shadow-lazy", "node_modules=package.json"]);
  });

  test("only the WSL distro applies shadows; under required on Windows it comes first", async () => {
    expect(driverFor({ backend: "wsl" }).shadows).toBe(true);
    for (const id of ["bwrap", "docker", "podman", "wslc", "apple"]) expect(Boolean(driverFor({ backend: id }).shadows)).toBe(false);
    const probeAll = async (preferShadows: boolean) => detectBackend({ platform: "win32", env: { SystemRoot: "/nonexistent" }, exists: () => false, run: down, fresh: true, preferShadows });
    const tried = (result: unknown) => ((result as { tried?: Array<{ backend: string }> }).tried ?? []).map((t) => t.backend);
    const plain = tried(await probeAll(false));
    const shadowed = tried(await probeAll(true));
    expect(plain.indexOf("wslc")).toBeLessThan(plain.indexOf("wsl"));
    expect(shadowed.indexOf("wsl")).toBeLessThan(shadowed.indexOf("wslc"));
  });
});

describe("build-artefact shadows: a box", () => {
  test("redirections in the env file, the plan for boxd, the agent's line, record.json; never in a snapshot", () => {
    const root = tmp("root");
    writeFileSync(path.join(root, "package.json"), "{}");
    writeFileSync(path.join(root, "pyproject.toml"), "");
    mkdirSync(path.join(root, "node_modules", "left"), { recursive: true });
    mkdirSync(path.join(root, "packages", "a", "node_modules"), { recursive: true });
    const home = tmp("home");
    const runFolder = path.join(home, "run", "k");
    mkdirSync(runFolder, { recursive: true });
    // What the wrappers and the git identity wrote before: kept.
    writeFileSync(path.join(runFolder, "env"), "BOXD_PATH_PREFIX=/x\nGIT_CONFIG_SYSTEM=/run/omnirush/gitconfig\n");
    const box = new Box({ key: "k", name: "omnirush-box-k", root, croot: root, runtime: { name: "wsl", backend: "wsl", bin: "wsl.exe" }, home, runFolder, run: down, log: () => {}, platform: "win32", env: { TZ: "UTC" } });
    const plan = shadowPlan(root, { platform: "win32", croot: root });
    // boxrun bound only the root's node_modules (a box started before keeps its own set).
    box.useShadows(plan, [`${root}/node_modules`]);
    box.useShadows(plan, [`${root}/node_modules`]);
    const envFile = readFileSync(path.join(runFolder, "env"), "utf8");
    expect(envFile).toBe(`TZ=UTC\nBOXD_PATH_PREFIX=/x\nGIT_CONFIG_SYSTEM=/run/omnirush/gitconfig\nUV_PROJECT_ENVIRONMENT=${store}/${shadowId(".")}/venv\n`);
    const forBoxd = JSON.parse(readFileSync(path.join(runFolder, "shadows.json"), "utf8"));
    expect(forBoxd.active).toEqual([`${root}/node_modules`]);
    expect(forBoxd.lazy).toEqual([{ dir: "node_modules", when_any: ["package.json"] }]);
    expect(forBoxd.store).toBe(store);
    const rec = JSON.parse(readFileSync(recordFile(home, "k"), "utf8"));
    expect(rec.shadows_note).toMatch(/^In the sandbox, node_modules(, \.venv)? are the sandbox's own Linux copies; your Windows copies are left as they are\. Install dependencies inside as needed\.$/);
    expect(BOX_NOTE(root, 0, root, rec.shadows_note)).toMatch(/\nIn the sandbox, node_modules/);
    expect(BOX_NOTE(root, 0, root)).not.toMatch(/own Linux copies/);
    // boxd bound packages/a/node_modules mid-chat (shadows-lazy.json): in the record, out of snapshots.
    writeFileSync(path.join(runFolder, "shadows-lazy.json"), JSON.stringify({ binds: [{ path: "packages/a/node_modules" }] }));
    const described = box.describe() as ReturnType<Box["describe"]> & { shadows?: unknown };
    expect(described.shadows).toEqual({ binds: [{ path: "node_modules", existed: true }, { path: "packages/a/node_modules", existed: false }], env: { UV_PROJECT_ENVIRONMENT: `${store}/${shadowId(".")}/venv` } });
    const skip = new Set(box.currentShadows()!.binds.map((b) => b.path));
    expect(dependencyFolders(root, { skip })).toEqual([]);
    expect(dependencyFolders(root).map((p) => path.relative(root, p)).sort()).toEqual(["node_modules", path.join("packages", "a", "node_modules")]);
    // No shadows: no shadows key and no note (as before).
    const plain = new Box({ key: "p", name: "omnirush-box-p", root, croot: root, runtime: { name: "bwrap", backend: "bwrap", bin: "boxrun" }, home, runFolder, run: down, log: () => {}, platform: "linux", env: {} });
    plain.writeRecord();
    expect("shadows" in plain.describe()).toBe(false);
    expect(JSON.parse(readFileSync(recordFile(home, "p"), "utf8")).shadows_note).toBeUndefined();
  });

  test("shadows only under required: a Windows WSL box (or the Mac VM) that is not required gets none, no line, no record key (CLI: the same)", () => {
    const root = tmp("noshadow");
    writeFileSync(path.join(root, "package.json"), "{}");
    mkdirSync(path.join(root, "node_modules"));
    for (const [platform, runtime] of [["win32", { name: "wsl", backend: "wsl", bin: "wsl.exe" }], ["darwin", { name: "lima", backend: "lima", bin: "limactl" }]] as const) {
      const plain = boxShadows({ required: false, runtime, root, platform, env: {} });
      expect(plain).toBeNull();
      expect(shadowsNotice(plain, platform)).toBeNull();
      const req = boxShadows({ required: true, runtime, root, platform, env: {} });
      expect(req?.binds.some((b) => b.path === "node_modules")).toBe(true);
    }
    const home = tmp("noshadow-home");
    const runFolder = path.join(home, "run", "k");
    mkdirSync(runFolder, { recursive: true });
    const box = new Box({ key: "k", name: "omnirush-box-k", root, croot: root, runtime: { name: "wsl", backend: "wsl", bin: "wsl.exe" }, home, runFolder, run: down, log: () => {}, platform: "win32", env: {} });
    expect("shadows" in box.describe()).toBe(false);
  });

  test("what a checkpoint leaves out follows the shadows the box really has (boxrun's answer), not this run's plan (CLI: the same)", () => {
    const root = tmp("opened");
    writeFileSync(path.join(root, "package.json"), "{}");
    mkdirSync(path.join(root, "node_modules"));
    mkdirSync(path.join(root, "web", "node_modules"), { recursive: true });
    const home = tmp("opened-home");
    const runFolder = path.join(home, "run", "k");
    mkdirSync(runFolder, { recursive: true });
    const box = new Box({ key: "k", name: "omnirush-box-k", root, croot: root, runtime: { name: "wsl", backend: "wsl", bin: "wsl.exe" }, home, runFolder, run: down, log: () => {}, platform: "win32", env: {} });
    const plan = shadowPlan(root, { platform: "win32", croot: root });
    box.useShadows({ ...plan, binds: plan.binds.filter((b) => b.path === "node_modules") }, [`${root}/node_modules`, `${root}/web/node_modules`, "/elsewhere/node_modules"]);
    const skip = new Set(box.currentShadows()!.binds.map((b) => b.path));
    expect([...skip].sort()).toEqual(["node_modules", "web/node_modules"]);
    expect(dependencyFolders(root, { skip })).toEqual([]);
    const later = new Box({ key: "k", name: "omnirush-box-k", root, croot: root, runtime: { name: "wsl", backend: "wsl", bin: "wsl.exe" }, home, runFolder, run: down, log: () => {}, platform: "win32", env: {} });
    later.useShadows({ binds: [], env: {}, dirs: [], scanned: 0, truncated: false, ms: 0 }, [`${root}/web/node_modules`], { lazy: false });
    expect(later.currentShadows()!.binds.map((b) => b.path)).toEqual(["web/node_modules"]);
    expect(JSON.parse(readFileSync(path.join(runFolder, "shadows.json"), "utf8")).lazy).toEqual([]);
  });
});
