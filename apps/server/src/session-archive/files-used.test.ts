import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import * as deps from "./deps.js";
import * as used from "./files-used.js";
import * as policy from "./files-used-policy.js";
import * as shell from "./files-used-shell.js";
import { SessionArchiver } from "./index.js";
import { ProjectArchiveLifecycle, type ProjectArchiver } from "./lifecycle.js";
import { outsideExclusion } from "./outside.js";
import { parseArchivePolicy } from "./policy.js";
import { openSealedBuffer, SEAL_ALG, sealKeyring } from "./seal.js";
import { readTar } from "./test-helpers.js";

// Files used (backend spec 19.7), the desktop's side. The pure modules
// (files-used-policy.ts, files-used-shell.ts, deps.ts) are byte-identical to
// the CLI's and are checked here against the same cases as its
// test/capture-files-used.test.js; the rest is the app side: staging at a
// tool call's end, the end-of-turn snapshot, the Settings switch, and the
// state document of a real chain.

const cleanups: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const stop of stops) await stop();
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});
const savedEnv = process.env.OMNIRUSH_ARCHIVE_FILES_USED;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.OMNIRUSH_ARCHIVE_FILES_USED;
  else process.env.OMNIRUSH_ARCHIVE_FILES_USED = savedEnv;
});

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", "-c", "commit.gpgSign=false", ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString();
}
function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(dir);
  return dir;
}
function write(file: string, content: string | Buffer): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

const uses = (command: string, cwd = "/w", home = "/home/u") => shell.shellCommandUses(command, cwd, home).map((use) => `${use.op} ${use.path}`).sort();

describe("shell command parsing (shared with the CLI)", () => {
  test("readers, redirections, cd chains and copies", () => {
    expect(uses("cat data/a.csv | head -n 5 > /tmp/out.txt")).toEqual(["read /w/data/a.csv", "write /tmp/out.txt"].sort());
    expect(uses("cd sub && tail -f logs/app.log 2>&1")).toEqual(["read /w/sub/logs/app.log"]);
    expect(uses("cp src/a.py /tmp/b.py && mv /tmp/b.py dist/")).toEqual(["read /tmp/b.py", "read /w/src/a.py", "write /tmp/b.py", "write /w/dist"].sort());
    expect(uses("echo hi > /dev/null; cat ~/notes.md")).toEqual(["read /home/u/notes.md"]);
  });

  test("interpreters run their script, read its arguments; -c code and heredocs name files", () => {
    expect(uses("python3 /tmp/gen.py --in data/x.csv out.json")).toEqual(["exec /tmp/gen.py", "read /w/data/x.csv", "read /w/out.json"].sort());
    expect(uses(`python -c "import json; json.load(open('settings.json')); open('/tmp/r.txt', 'w').write('x')"`)).toEqual(["read /w/settings.json", "write /tmp/r.txt"].sort());
    expect(uses("source .venv/bin/activate && . ./env.sh")).toEqual(["exec /w/.venv/bin/activate", "exec /w/env.sh"].sort());
    expect(uses("cat > /tmp/s.sh <<EOF\necho hi\nEOF\nbash /tmp/s.sh")).toEqual(["exec /tmp/s.sh", "write /tmp/s.sh"].sort());
    expect(uses("sed -i 's/a/b/' conf.ini")).toEqual(["write /w/conf.ini"]);
  });

  test("git: every command loads the user's git config (implicit); config keys and values are not paths; pathspecs only after --", () => {
    const git = (command: string) => shell.shellCommandUses(command, "/w", "/home/u").map((use) => `${use.op} ${use.path}${use.implicit ? " (implicit)" : ""}`).sort();
    const config = ["read /home/u/.config/git/config (implicit)", "read /home/u/.gitconfig (implicit)"];
    expect(git("git config --global --get user.name")).toEqual(config);
    expect(git("git config --get-all remote.origin.url")).toEqual(config);
    expect(git("git log -1")).toEqual(config);
    expect(git("git add src/a.py")).toEqual(config);
    expect(git("git config user.email a@b.c")).toEqual([...config, "write /w/.git/config"].sort());
    expect(git("git config --global core.editor vim")).toEqual([...config, "write /home/u/.gitconfig"].sort());
    expect(git("git config -f ci/git.cfg --get x.y")).toEqual([...config, "read /w/ci/git.cfg"].sort());
    expect(git("git -C sub diff HEAD~1 -- src/a.py README.md")).toEqual([...config, "read /w/sub/README.md", "read /w/sub/src/a.py"].sort());
  });

  test("variables, globs, URLs and options are never paths", () => {
    expect(uses("curl -s https://example.com/a.json -o $OUT; ls *.py; echo $USER/x")).toEqual([]);
    // A commit message is no path (git's own config reads are the only uses).
    expect(uses("git commit -m 'fix: a.b'")).toEqual(["read /home/u/.config/git/config", "read /home/u/.gitconfig"]);
  });

  test("temp and home variables expand with the session's values; Windows reads Git Bash, cmd and PowerShell forms", () => {
    const linux = (command: string, env: Record<string, string> = { TMPDIR: "/var/tmpx", HOME: "/home/env" }) => shell.shellCommandUses(command, "/w", "/home/u", env, "linux").map((use) => `${use.op} ${use.path}`).sort();
    expect(linux("cat $TMPDIR/a/b.txt ${TMPDIR}/c.txt; cat $HOME/x.txt ${HOME}/y.txt")).toEqual(["read /home/u/x.txt", "read /home/u/y.txt", "read /var/tmpx/a/b.txt", "read /var/tmpx/c.txt"]);
    // Linux and macOS: only TMPDIR and HOME; an unset variable stays unread.
    expect(linux("cat $TEMP/a.txt $TMPDIR/b.txt", {})).toEqual([]);
    const env = { TEMP: "C:\\Users\\a\\AppData\\Local\\Temp", TMP: "C:\\Users\\a\\AppData\\Local\\Temp", USERPROFILE: "C:\\Users\\a", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", APPDATA: "C:\\Users\\a\\AppData\\Roaming" };
    const win = (command: string) => shell.shellCommandUses(command, "C:\\w", "C:\\Users\\a", env, "win32").map((use) => `${use.op} ${use.path}`);
    const temp = "C:\\Users\\a\\AppData\\Local\\Temp\\a\\b\\c\\x.txt";
    for (const form of ["$TEMP/a/b/c/x.txt", "${TEMP}/a/b/c/x.txt", "$TMP/a/b/c/x.txt", "$TMPDIR/a/b/c/x.txt", "%TEMP%\\a\\b\\c\\x.txt", "%temp%/a/b/c/x.txt", "$env:TEMP\\a\\b\\c\\x.txt", "${env:TEMP}/a/b/c/x.txt", "/tmp/a/b/c/x.txt", "/c/Users/a/AppData/Local/Temp/a/b/c/x.txt", "$LOCALAPPDATA/Temp/a/b/c/x.txt", "%USERPROFILE%\\AppData\\Local\\Temp\\a\\b\\c\\x.txt", "$HOME/AppData/Local/Temp/a/b/c/x.txt"]) {
      expect(win(`echo x > ${form}`)).toEqual([`write ${temp}`]);
    }
    expect(win("cat $APPDATA/app/c.json")).toEqual(["read C:\\Users\\a\\AppData\\Roaming\\app\\c.json"]);
    expect(win("cd $TEMP/run && cat out.json")).toEqual(["read C:\\Users\\a\\AppData\\Local\\Temp\\run\\out.json"]);
    // Other variables stay as they were.
    expect(win("cat $OUT/x.txt")).toEqual([]);
  });
});

const context = { roots: ["/w"], home: "/home/u", temps: ["/tmp"], appDirs: ["/home/u/.omnirush"] };
const classify = (absolute: string) => {
  const value = policy.classifyUse(absolute, context);
  return value ? `${value.scope} ${value.plan} ${value.reason}` : null;
};

describe("policy (shared with the CLI)", () => {
  test("credentials, keys, .env and token files are never archived, wherever they are", () => {
    expect(classify("/w/.env")).toBe("project hold denylisted");
    expect(classify("/w/.env.example")).toBe("project scan captured");
    expect(classify("/w/certs/server.key")).toBe("project hold denylisted");
    expect(classify("/home/u/.ssh/config")).toBe("home hold denylisted");
    expect(classify("/home/u/.aws/credentials")).toBe("home hold denylisted");
    expect(classify("/home/u/.netrc")).toBe("home hold denylisted");
    expect(classify("/tmp/token.txt")).toBe("tmp hold denylisted");
  });

  test("home settings only through the allowlist; dependency and build folders hash only; system files never", () => {
    expect(classify("/home/u/.gitconfig")).toBe("home stage captured");
    expect(classify("/home/u/.npmrc")).toBe("home hold denylisted");
    expect(classify("/home/u/.pypirc")).toBe("home hold denylisted");
    expect(classify("/home/u/.yarnrc.yml")).toBe("home stage captured");
    expect(classify("/home/u/.config/pip/pip.conf")).toBe("home stage captured");
    expect(classify("/home/u/.bashrc")).toBe("home hold not_allowlisted");
    // Home files off the config allowlist are listed only, wherever they are under the home.
    expect(classify("/home/u/Downloads/data.csv")).toBe("home hold not_allowlisted");
    expect(classify("/home/u/Documents/report.docx")).toBe("home hold not_allowlisted");
    expect(classify("/home/u/other-project/src/main.py")).toBe("home hold not_allowlisted");
    expect(classify("/home/u/.cache/pip/x.whl")).toBe("home hold dependency_dir");
    expect(classify("/w/node_modules/a/index.js")).toBe("project hold dependency_dir");
    expect(classify("/w/dist/app.js")).toBe("project hold build_output");
    expect(classify("/w/config.local.yaml")).toBe("project scan captured");
    expect(classify("/tmp/shot.png")).toBe("tmp stage captured");
    expect(classify("/etc/hosts")).toBe("outside hold denylisted");
    expect(classify("/data/in.parquet")).toBe("outside scan captured");
    expect(classify("/home/u/.omnirush/auth.json")).toBeNull();
  });

  test("home config scrub: no auth, token or credential line survives; URLs lose their userinfo", () => {
    const npm = policy.scrubHomeConfig("npmrc", "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=npm_FAKEFAKEFAKEFAKEFAKE\n@acme:registry=https://user:pw@npm.acme.dev/\n")!;
    expect(npm).not.toContain("npm_FAKE");
    expect(npm).not.toContain("user:pw");
    expect(npm).toContain("@acme:registry=https://npm.acme.dev/");
    const gitText = policy.scrubHomeConfig("git", "[user]\n\tname = Sam\n[credential]\n\thelper = store\n[remote \"o\"]\n\turl = https://x:ghp_FAKE@github.com/a/b\n")!;
    expect(gitText).not.toContain("helper = store");
    expect(gitText).not.toContain("ghp_FAKE");
    expect(gitText).toContain("name = Sam");
    expect(policy.scrubHomeConfig("text", "a\u0000b")).toBeNull();
  });

  test("manifest: the format, `captured` from what the chain holds, the reasons", () => {
    const items = policy.finalizeFilesUsed([
      { path: "src/a.py", scope: "project", op: "read", size: 3, sha256: "a".repeat(64), plan: "scan", reason: "captured", turn: 1 },
      { path: "/tmp/gone.png", scope: "tmp", op: "write", size: null, sha256: null, plan: "staged", reason: "captured", archive_path: "__outside__/tmp/gone.png", turn: 1 },
      { path: "/tmp/kept.png", scope: "tmp", op: "write", size: 9, sha256: "b".repeat(64), plan: "staged", reason: "captured", archive_path: "__outside__/tmp/kept.png", turn: 1, call_id: "call_1" },
      { path: "/data/big.bin", scope: "outside", op: "read", size: 9e9, sha256: null, plan: "scan", reason: "captured", turn: 1 },
      { path: "node_modules/x/i.js", scope: "project", op: "read", size: 1, sha256: "c".repeat(64), plan: "hold", reason: "dependency_dir", turn: 1 },
    ], new Set(["src/a.py", "__outside__/tmp/kept.png"]));
    expect(items.map((item) => `${item.path} ${item.captured} ${item.reason}`)).toEqual([
      "/data/big.bin false too_large",
      "/tmp/gone.png false missing",
      "/tmp/kept.png true captured",
      "node_modules/x/i.js false dependency_dir",
      "src/a.py true captured",
    ]);
    expect(Object.keys(items[2]!).sort()).toEqual(["call_id", "captured", "op", "path", "reason", "scope", "sha256", "size"]);
    expect(policy.FILES_USED_REASONS).toEqual(["captured", "dependency_dir", "build_output", "denylisted", "not_allowlisted", "too_large", "missing"]);
    expect(policy.MAX_FILES_USED_FILE_BYTES).toBe(64 * 1024 * 1024);
    expect(policy.MAX_FILES_USED_SESSION_BYTES).toBe(256 * 1024 * 1024);
  });

  test("GET /archives/key: files_used and its caps; no client override", () => {
    expect(parseArchivePolicy({ policy: { capture_v2: true, files_used: true, files_used_max_file_bytes: 1024, files_used_max_session_bytes: null } }))
      .toEqual({ allFolders: false, touchedFiles: false, captureV2: true, filesUsed: true, filesUsedMaxFileBytes: 1024 });
    expect(parseArchivePolicy({ policy: { files_used: false } }).filesUsed).toBeUndefined();
    expect((policy as Record<string, unknown>).filesUsedOverride).toBeUndefined();
    expect((used as Record<string, unknown>).filesUsedOverride).toBeUndefined();
  });

  test("dependencies: every subproject's lockfile with its resolved versions", async () => {
    const root = temp("omnirush-fu-deps-");
    write(join(root, "package.json"), "{}");
    write(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { version: "1.3.0" } } }));
    write(join(root, "api", "pyproject.toml"), "[project]\nname='a'\n");
    write(join(root, "api", "uv.lock"), "version = 1\n\n[[package]]\nname = \"requests\"\nversion = \"2.32.3\"\n");
    write(join(root, "node_modules", "z", "package-lock.json"), "{}");
    const projects = await used.collectDependencyProjects(root);
    expect(projects.map((project) => [project.dir, project.ecosystem, project.lockfile, project.resolved])).toEqual([
      [".", "npm", "package-lock.json", { "left-pad": "1.3.0" }],
      ["api", "uv", "api/uv.lock", { requests: "2.32.3" }],
    ]);
    expect(deps.lockfileEcosystem("go.sum")).toBe("go");
  });
});

describe("the desktop side", () => {
  test("outside scan: home settings are never archived as they are (an allowlisted config only scrubbed, through files used)", () => {
    const home = "/home/u";
    expect(outsideExclusion("/home/u/.gitconfig", { appDirs: [], home })).toBe("credential");
    expect(outsideExclusion("/home/u/Library/Preferences/x.plist", { appDirs: [], home })).toBe("credential");
    expect(outsideExclusion("/home/u/Downloads/data.csv", { appDirs: [], home })).toBeNull();
    expect(outsideExclusion("/tmp/shot.png", { appDirs: [], home })).toBeNull();
  });

  test("end-of-turn snapshot: files changed since the turn started, gitignored ones too, never .git, dependency or build output folders", async () => {
    const root = temp("omnirush-fu-snap-");
    for (const file of ["src/a.py", "README.md", ".git/HEAD"]) write(join(root, file), "x");
    // The turn starts after these were written (ctime cannot be set back, so the turn is moved ahead instead).
    const since = Date.now() + 2_500;
    const later = (Date.now() + 10_000) / 1000;
    for (const file of ["results/report.csv", "node_modules/x/i.js", ".git/index", "dist/app.js", "target/x.o"]) {
      write(join(root, file), "1");
      utimesSync(join(root, file), later, later);
    }
    const found = (await used.changedSince(root, since, Date.now() + 5_000)).map((path) => path.slice(root.length + 1)).sort();
    expect(found).toEqual(["results/report.csv"]);
    // A spent budget stops the walk.
    expect(await used.changedSince(root, since, Date.now() - 1)).toEqual([]);
  });

  test("engine events: a finished tool call (v1 and v2 shapes)", () => {
    const v1 = used.finishedToolCallOf({ type: "message.part.updated", properties: { part: { type: "tool", tool: "bash", callID: "c1", sessionID: "s1", state: { status: "completed", input: { command: "ls" }, time: { start: 1, end: 2 } } } } });
    expect(v1).toEqual({ sessionId: "s1", call: { callId: "c1", tool: "bash", input: { command: "ls" }, start: 1, end: 2 } });
    expect(used.finishedToolCallOf({ type: "message.part.updated", properties: { part: { type: "tool", tool: "bash", callID: "c1", sessionID: "s1", state: { status: "running", input: {} } } } })).toBeNull();
    expect(used.finishedToolCallOf({ directory: "/w", payload: { type: "session.tool.completed", data: { sessionID: "s2", tool: "read", callID: "c2", input: { filePath: "/w/a" } } } })?.call.tool).toBe("read");
  });

  test("lifecycle: a turn's files are listed ahead of its delta; the turn start notes the time only", async () => {
    const order: string[] = [];
    const archiver = {
      captureBase: async () => ({ status: "skipped", reason: "exists" }),
      captureDelta: async () => {
        order.push("delta");
        return { status: "skipped", reason: "unchanged" };
      },
      captureFinal: async () => ({ status: "skipped", reason: "unchanged" }),
      startFinalCandidates: async () => [],
      recordTouched: () => undefined,
      forgetTouched: () => undefined,
      drain: async () => ({ uploaded: 0, failed: 0, remaining: 0 }),
      signOut: async () => undefined,
      stop: async () => undefined,
      filesUsedTurnStarted: () => order.push("started"),
      filesUsedTurnEnded: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("files_used");
        return { items: 1, staged: 0, ms: 20, snapshot: 0 };
      },
      filesUsedToolCallEnded: async () => {
        order.push("call");
      },
    } as unknown as ProjectArchiver;
    const lifecycle = new ProjectArchiveLifecycle({ archiver, enabled: true, log: () => undefined, finalIdleMs: 0 });
    const engine = { session: async () => ({ id: "ses_l", parentID: null }), messages: async () => [] };
    lifecycle.sessionStarted({ sessionId: "ses_l", root: temp("omnirush-fu-life-"), engine });
    await lifecycle.settled();
    lifecycle.turnFollowed("ses_l");
    lifecycle.toolCallEnded("ses_l", { callId: "c", tool: "bash", input: { command: "ls" }, start: 1, end: 2 });
    lifecycle.turnFilesUsed("ses_l", []);
    lifecycle.turnCompleted("ses_l", []);
    await lifecycle.settled();
    expect(order).toEqual(["started", "call", "files_used", "delta"]);
  });
});

type Opened = { members: Map<string, Buffer>; bytes: Buffer; manifest: { files: Array<{ path: string }> }; state: Record<string, unknown> & { files_used?: policy.FilesUsedItem[]; dependencies?: Array<{ lockfile: string }>; state: { kind: string; turn: number } } };

function rig(keyPolicy: Record<string, unknown> | (() => Record<string, unknown>), routes: Record<string, (init: { method: string; body?: string }) => Response> = {}, now?: () => Date) {
  const stateDir = temp("omnirush-fu-state-");
  const keyring = sealKeyring([randomBytes(32)]);
  const { publicRaw, kid } = [...keyring.values()][0]!;
  const request = async (route: string, init: { method: string; body?: string }) => {
    if (route === "archives/key") return Response.json({ public_key: publicRaw.toString("base64"), kid, alg: SEAL_ALG, policy: typeof keyPolicy === "function" ? keyPolicy() : keyPolicy });
    const handler = routes[route];
    return handler ? handler(init) : new Response("{}", { status: 404 });
  };
  const archiver = new SessionArchiver({ stateDir, request, excludedDirs: [stateDir], log: () => undefined, touchedFlushMs: 10, ...(now ? { now } : {}) });
  stops.push(() => archiver.stop({ budgetMs: 1000 }));
  const open = async (result: Awaited<ReturnType<SessionArchiver["captureBase"]>>): Promise<Opened> => {
    if (result.status !== "queued") throw new Error(`not queued: ${JSON.stringify(result)}`);
    const sealed = readFileSync(join(stateDir, "omnirush-archive", "pending", `${result.archiveId}.orseal`));
    const bytes = zstdDecompressSync(await openSealedBuffer(sealed, keyring));
    const members = new Map(readTar(bytes).map((member) => [member.name, member.content]));
    return {
      members,
      bytes,
      manifest: JSON.parse(members.get("__omnirush__/manifest.json")!.toString("utf8")),
      state: JSON.parse(members.get("__omnirush__/state.json")!.toString("utf8")),
    };
  };
  return { archiver, open, stateDir };
}

const toolPart = (callID: string, tool: string, input: Record<string, unknown>, start = Date.now() - 1000, end = Date.now()) => ({ type: "tool", tool, callID, state: { status: "completed", input, time: { start, end } } });
const turn = (...parts: unknown[]) => [{ info: { role: "user" }, parts: [] }, { info: { role: "assistant", time: { completed: Date.now() } }, parts }];
const callOf = (part: unknown) => used.usedToolCallOf(part)!;

function project(): string {
  const root = temp("omnirush-fu-root-");
  write(join(root, ".gitignore"), "config.local.yaml\nnode_modules/\n.env\nresults/\n");
  write(join(root, "app.py"), "print(1)\n");
  write(join(root, "package.json"), "{}");
  write(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/a": { version: "1.0.0" } } }));
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  write(join(root, "config.local.yaml"), "mode: local\n");
  write(join(root, ".env"), "API_TOKEN=abcdefgh123\n");
  write(join(root, "node_modules", "a", "index.js"), "module.exports = 1\n");
  return root;
}

describe("a files-used chain", () => {
  test("temp scripts kept at call end, gitignored inputs, scrubbed home config, a turn's new gitignored output; secrets held; an after state for a quiet turn", async () => {
    const { archiver, open } = rig({ capture_v2: true, files_used: true });
    const root = project();
    const scratch = temp("omnirush-fu-tmp-");
    const home = temp("omnirush-fu-home-");
    write(join(home, ".gitconfig"), "[user]\n\tname = T\n[credential]\n\thelper = store\n");
    write(join(home, ".npmrc"), "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=npm_FAKEFAKEFAKEFAKE1234\n");
    write(join(home, ".bashrc"), "export SECRET_THING=1\n");
    const tracker = new used.FilesUsedTracker({ archive: archiver, appDirs: [], home, temps: [scratch] });

    const sessionId = "ses_files_used_gui_1";
    await archiver.startManifest(sessionId, root);
    const base = await open(await archiver.captureBase(sessionId, root, 0));
    expect(base.state.files_used).toEqual([]);
    expect(base.state.dependencies!.map((item) => item.lockfile)).toEqual(["package-lock.json"]);
    expect(await archiver.filesUsedActive(sessionId)).toBe(true);

    tracker.turnStarted(sessionId);
    const script = write(join(scratch, "gen.py"), "print(open('config.local.yaml').read())\n");
    const call1 = toolPart("call_1", "write", { filePath: script, content: "..." });
    await tracker.toolCallEnded(sessionId, root, callOf(call1));
    const call2 = toolPart("call_2", "bash", { command: `python3 ${script} config.local.yaml && git config --global --get user.name && cat ~/.npmrc ~/.bashrc .env node_modules/a/index.js && rm ${script}` });
    await tracker.toolCallEnded(sessionId, root, callOf(call2));
    rmSync(script);
    // Written by the script without being named: only the end-of-turn snapshot sees it.
    write(join(root, "results", "report.csv"), "a,b\n1,2\n");

    const listed = await tracker.turnEnded(sessionId, root, turn(call1, call2));
    expect(listed.items).toBeGreaterThanOrEqual(7);
    expect(listed.snapshot).toBeGreaterThanOrEqual(1);
    const after = await open(await archiver.captureDelta(sessionId, root, 1));
    expect(after.state.state).toEqual({ kind: "after", turn: 1 });
    const items = new Map(after.state.files_used!.map((item) => [item.path, item]));
    const expectItem = (key: string, scope: string, op: string, captured: boolean, reason: string) => {
      const item = items.get(key);
      expect(item, `${key} in ${[...items.keys()].join(", ")}`).toBeDefined();
      expect([item!.scope, item!.op, item!.captured, item!.reason] as unknown[]).toEqual([scope, op, captured, reason]);
    };
    expectItem(script, "tmp", "write", true, "captured");
    expectItem("config.local.yaml", "project", "read", true, "captured");
    expectItem("results/report.csv", "project", "write", true, "captured");
    expectItem(join(home, ".gitconfig"), "home", "read", true, "captured");
    expectItem(join(home, ".npmrc"), "home", "read", false, "denylisted");
    expectItem(join(home, ".bashrc"), "home", "read", false, "not_allowlisted");
    expectItem(".env", "project", "read", false, "denylisted");
    expectItem("node_modules/a/index.js", "project", "read", false, "dependency_dir");
    expect(items.get(script)!.call_id).toBe("call_1");
    // git loaded ~/.gitconfig without naming it (listed, scrubbed); ~/.config/git/config is not there (not listed).
    expect(items.has(join(home, ".config", "git", "config"))).toBe(false);
    expect([...items.keys()].some((key) => key.endsWith("user.name"))).toBe(false);
    // Hashes the turn end left to the scan come from the chain.
    expect(items.get("config.local.yaml")!.sha256).toBe(sha256("mode: local\n"));
    expect(items.get("results/report.csv")!.sha256).toBe(sha256("a,b\n1,2\n"));
    expect(items.get(".env")!.sha256).toBeNull();
    for (const item of items.values()) expect(Object.keys(item).every((key) => ["path", "scope", "op", "size", "sha256", "captured", "reason", "call_id"].includes(key))).toBe(true);

    const outside = (absolute: string) => `__outside__${absolute}`;
    expect(after.members.get(outside(script))?.toString()).toBe("print(open('config.local.yaml').read())\n");
    expect(after.members.get("config.local.yaml")?.toString()).toBe("mode: local\n");
    expect(after.members.get("results/report.csv")?.toString()).toBe("a,b\n1,2\n");
    const gitconfig = after.members.get(outside(join(home, ".gitconfig")))?.toString() ?? "";
    expect(gitconfig).toContain("name = T");
    expect(gitconfig).not.toContain("helper = store");
    expect(items.get(join(home, ".gitconfig"))!.sha256).toBe(sha256(gitconfig));
    const text = after.bytes.toString("latin1");
    for (const secret of ["npm_FAKEFAKEFAKEFAKE1234", "abcdefgh123", "SECRET_THING", "helper = store"]) expect(text.includes(secret), secret).toBe(false);
    expect(after.members.has(outside(join(home, ".bashrc")))).toBe(false);
    expect(after.members.has("node_modules/a/index.js")).toBe(false);
    expect(after.members.has(".env")).toBe(false);

    // A quiet turn still gets its after state; the kept temp copy stays in the chain (no deletion).
    const quiet = await open(await archiver.captureDelta(sessionId, root, 2));
    expect(quiet.state.state).toEqual({ kind: "after", turn: 2 });
    expect(quiet.state.files_used).toEqual([]);
    expect(quiet.manifest.files).toEqual([]);
    expect((quiet.manifest as unknown as { deleted?: string[] }).deleted ?? []).toEqual([]);
    expect(quiet.state.dependencies).toBeUndefined();
  });

  test("omnirush.ai's flag drives it: decided at a session's base (new sessions only), and the notice status says so", async () => {
    const line = "OmniRush also saves the files the agent reads, runs or creates during a session (including temporary files and a few allowlisted config files, with secrets removed), so the session can be replayed.";
    let flag = false;
    let clock = Date.now();
    const { archiver, open } = rig(() => ({ capture_v2: true, files_used: flag, files_used_consent_text: flag ? line : null }), {}, () => new Date(clock));
    const root = project();
    const sessionId = "ses_files_used_gui_flag";
    const base = await open(await archiver.captureBase(sessionId, root, 0));
    expect(base.state.files_used).toBeUndefined();
    expect(await archiver.filesUsedActive(sessionId)).toBe(false);
    expect(archiver.filesUsedMaybe()).toBe(false);
    expect(await archiver.filesUsedStatus()).toEqual({ active: false, available: false, consentText: null });

    // Turned on while the session runs: that session stays as it began (its notice moment has passed).
    flag = true;
    clock += 6 * 60_000;
    const read = toolPart("r", "read", { filePath: join(root, "config.local.yaml") });
    expect((await archiver.filesUsedTurnEnded(sessionId, root, turn(read))).items).toBe(0);
    expect(await archiver.filesUsedActive(sessionId)).toBe(false);
    expect(await archiver.filesUsedStatus()).toEqual({ active: true, available: true, consentText: line });

    // The next session (the app shows the line when it opens) records them from its base on.
    const next = "ses_files_used_gui_flag2";
    const nextBase = await open(await archiver.captureBase(next, root, 0));
    expect(nextBase.state.files_used).toEqual([]);
    expect((await archiver.filesUsedTurnEnded(next, root, turn(read))).items).toBeGreaterThanOrEqual(1);
    const on = await open(await archiver.captureDelta(next, root, 1));
    expect(on.state.files_used!.find((item) => item.path === "config.local.yaml")?.captured).toBe(true);
  });

  test("OMNIRUSH_ARCHIVE_FILES_USED in the environment never turns recording on (no client override)", async () => {
    process.env.OMNIRUSH_ARCHIVE_FILES_USED = "1";
    const off = rig({ capture_v2: true, files_used: false });
    const root = project();
    const base = await off.open(await off.archiver.captureBase("ses_files_used_gui_env1", root, 0));
    expect(base.state.files_used).toBeUndefined();
    expect(await off.archiver.filesUsedActive("ses_files_used_gui_env1")).toBe(false);
    // Before any answer from omnirush.ai, nothing either.
    const fresh = rig({ capture_v2: true, files_used: false });
    expect(await fresh.archiver.filesUsedActive("ses_files_used_gui_env2")).toBe(false);
  });

  test("a home file off the config allowlist (~/Downloads) is listed not_allowlisted and its bytes never reach the chain", async () => {
    // A folder under the real home (bun keeps the home it started with): only the home rules apply to it.
    const home = realpathSync(mkdtempSync(join(homedir(), ".omnirush-fu-home-")));
    cleanups.push(home);
    {
      const { archiver, open } = rig({ capture_v2: true, files_used: true });
      const root = project();
      const notes = write(join(home, "Downloads", "fu-notes.txt"), "DOWNLOADS-BYTES-fu\n");
      const sessionId = "ses_files_used_gui_home";
      await open(await archiver.captureBase(sessionId, root, 0));
      const call = toolPart("c", "bash", { command: `cat ${notes}` });
      await archiver.filesUsedToolCallEnded(sessionId, root, callOf(call));
      // The session uploader reports it as touched too (outside capture).
      archiver.recordTouched(sessionId, notes);
      await archiver.filesUsedTurnEnded(sessionId, root, turn(call));
      const after = await open(await archiver.captureDelta(sessionId, root, 1));
      const item = after.state.files_used!.find((entry) => entry.path === notes);
      expect(item, JSON.stringify(after.state.files_used)).toBeDefined();
      expect([item!.scope, item!.captured, item!.reason, item!.size] as unknown[]).toEqual(["home", false, "not_allowlisted", 19]);
      expect([...after.members.keys()].some((name) => name.includes("Downloads"))).toBe(false);
      expect(after.bytes.toString("latin1")).not.toContain("DOWNLOADS-BYTES-fu");
    }
  });

  test("a withdrawal on omnirush.ai stops recording at the next turn whose answer is old", async () => {
    let accepted = true;
    let clock = Date.now();
    const { archiver, open } = rig(() => ({ capture_v2: true, files_used: accepted }), {}, () => new Date(clock));
    const root = project();
    const sessionId = "ses_files_used_gui_withdraw";
    await open(await archiver.captureBase(sessionId, root, 0));
    expect(await archiver.filesUsedActive(sessionId)).toBe(true);
    accepted = false;
    clock += 6 * 60_000;
    const read = toolPart("r", "read", { filePath: join(root, "config.local.yaml") });
    expect((await archiver.filesUsedTurnEnded(sessionId, root, turn(read))).items).toBe(0);
    expect(await archiver.filesUsedActive(sessionId)).toBe(false);
  });

  test("off: a server without files_used keeps the chain as it was", async () => {
    const { archiver, open } = rig({ capture_v2: true });
    const root = project();
    const sessionId = "ses_files_used_gui_off";
    const base = await open(await archiver.captureBase(sessionId, root, 0));
    expect(base.state.files_used).toBeUndefined();
    expect(base.state.dependencies).toBeUndefined();
    expect(await archiver.filesUsedActive(sessionId)).toBe(false);
    expect(archiver.filesUsedMaybe()).toBe(false);
    const result = await archiver.filesUsedTurnEnded(sessionId, root, turn(toolPart("c", "read", { filePath: join(root, "config.local.yaml") })));
    expect(result.items).toBe(0);
    expect(await archiver.captureDelta(sessionId, root, 1)).toMatchObject({ status: "skipped", reason: "unchanged" });
  });

  test("caps: a used file over the per-file cap is listed with its size only, never copied", async () => {
    const { archiver, open } = rig({ capture_v2: true, files_used: true, files_used_max_file_bytes: 1024 });
    const root = project();
    const scratch = temp("omnirush-fu-cap-");
    const big = write(join(scratch, "big.bin"), randomBytes(4096));
    const small = write(join(scratch, "small.txt"), "ok\n");
    const sessionId = "ses_files_used_gui_cap";
    await open(await archiver.captureBase(sessionId, root, 0));
    const tracker = new used.FilesUsedTracker({ archive: archiver, appDirs: [], temps: [scratch] });
    const call = toolPart("c", "bash", { command: `cat ${big} ${small}` });
    await tracker.turnEnded(sessionId, root, turn(call));
    const after = await open(await archiver.captureDelta(sessionId, root, 1));
    const items = new Map(after.state.files_used!.map((item) => [item.path, item]));
    expect([items.get(big)!.captured, items.get(big)!.reason, items.get(big)!.size]).toEqual([false, "too_large", 4096]);
    expect([items.get(small)!.captured, items.get(small)!.reason]).toEqual([true, "captured"]);
    expect(after.members.has(`__outside__${big}`)).toBe(false);
  });
});

test("Windows temp: files under the home's AppData/Local/Temp are temp files (staged), whatever spelling `temps` has; credentials there still never", () => {
  expect(classify("/home/u/AppData/Local/Temp/work2/crash-distributed/provenance.json")).toBe("tmp stage captured");
  expect(classify("/home/u/appdata/local/temp/x/a.txt")).toBe("tmp stage captured");
  expect(classify("/home/u/AppData/Local/Temp/x/.env")).toBe("tmp hold denylisted");
  expect(classify("/home/u/AppData/Local/Temp/x/node_modules/a.js")).toBe("tmp hold dependency_dir");
  expect(classify("/home/u/AppData/Roaming/app/state.json")).toBe("home hold not_allowlisted");
  expect(classify("/home/u/AppData/Local/npm-cache/x.tgz")).toBe("home hold dependency_dir");
});

test("files used: the yarn release and plugins .yarnrc.yml names are kept, the rest of .yarn is not", () => {
  expect(used.yarnrcFiles("yarnPath: .yarn/releases/yarn-3.3.1.cjs\nplugins:\n  - path: .yarn/plugins/@yarnpkg/plugin-workspace-tools.cjs\n    spec: \"@yarnpkg/plugin-workspace-tools\"\nnodeLinker: node-modules\n")).toEqual([".yarn/releases/yarn-3.3.1.cjs", ".yarn/plugins/@yarnpkg/plugin-workspace-tools.cjs"]);
  expect(used.yarnrcFiles("yarnPath: \"./.yarn/releases/yarn-4.0.2.cjs\" # pinned\n")).toEqual(["./.yarn/releases/yarn-4.0.2.cjs"]);
  const context = { roots: ["/w"], home: "/home/u", temps: ["/tmp"], appDirs: [] };
  const kind = (absolute: string) => {
    const value = policy.classifyUse(absolute, context)!;
    return `${value.plan} ${value.reason}`;
  };
  expect(kind("/w/.yarn/releases/yarn-3.3.1.cjs")).toBe("scan captured");
  expect(kind("/w/.yarn/plugins/@yarnpkg/plugin-workspace-tools.cjs")).toBe("scan captured");
  expect(kind("/w/packages/app/.yarn/releases/yarn-3.3.1.cjs")).toBe("scan captured");
  expect(kind("/w/.yarn/cache/lodash-npm-4.17.21-6382451519-eb835a2e51.zip")).toBe("hold dependency_dir");
  expect(kind("/w/.yarn/unplugged/esbuild/node_modules/esbuild/bin/esbuild")).toBe("hold dependency_dir");
  expect(kind("/w/.yarn/install-state.gz")).toBe("hold dependency_dir");
});

test("belowDir: a drive path compares the Windows way (either slash, any case), a POSIX path the POSIX way", () => {
  const temp = "C:\\Users\\SNEHAS~1\\AppData\\Local\\Temp";
  expect(policy.belowDir(temp, "C:\\Users\\SNEHAS~1\\AppData\\Local\\Temp\\run\\out.json")).toBe(true);
  expect(policy.belowDir(temp, "c:/users/snehas~1/appdata/local/temp/run/out.json")).toBe(true);
  expect(policy.belowDir(temp, temp)).toBe(false);
  expect(policy.belowDir(temp, "C:\\Users\\SNEHAS~1\\AppData\\Local\\Temp2\\x")).toBe(false);
  expect(policy.belowDir("/tmp", "/tmp/x/a")).toBe(true);
  expect(policy.belowDir("/tmp", "/tmpx/a")).toBe(false);
  expect(policy.belowDir("/tmp", "/tmp")).toBe(false);
});
