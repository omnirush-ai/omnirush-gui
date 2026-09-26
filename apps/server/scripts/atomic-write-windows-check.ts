/**
 * Windows check for the atomic settings writes (src/atomic-write.ts).
 *
 *   bun --conditions=development apps/server/scripts/atomic-write-windows-check.ts <tmpdir>
 *     [--saves 300] [--hold-ms 3] [--gap-ms 7] [--pause-ms 2] [--strict]
 *
 * While holder processes keep opening the settings file (and any temp file
 * next to it) for a few ms at a time, the way antivirus and the search
 * indexer do, it saves the sub-agent setting many times two ways:
 *
 *   control: the old plain temp file + rename, no retry;
 *   fixed:   the real writeSubagentModelSetting (fsync + rename with retry).
 *
 * Holders: this script in holder mode (fs.openSync(path, "r")), and on
 * Windows also a PowerShell loop opening with [IO.File]::Open(..., FileShare
 * ReadWrite), i.e. without FILE_SHARE_DELETE, which is what makes replacing
 * the file fail there. The control's failures show the holders reproduce the
 * bug; the fixed path must have none.
 *
 * Prints a JSON summary. Exits 0 only when the fixed path saved every time,
 * the file holds the last saved value and no temp file is left behind.
 * --strict also requires the control to fail at least once on Windows (the
 * reproduction worked). On Linux and macOS a rename over an open file always
 * succeeds, so the check passes trivially there.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SETTING_FILE = "omnirush-subagent-model.json";

function flag(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} needs a number`);
  return value;
}

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Holder mode: open every file in the directories for holdMs, pause gapMs, forever. */
function runNodeHolder(parentPid: number, dirs: string[], holdMs: number, gapMs: number): never {
  process.stdout.write("ready\n");
  for (let round = 0; ; round += 1) {
    if (round % 50 === 0) {
      // Never outlive the check (killed or crashed).
      try {
        process.kill(parentPid, 0);
      } catch {
        process.exit(0);
      }
    }
    for (const dir of dirs) {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      const handles: number[] = [];
      for (const name of names) {
        try {
          handles.push(openSync(join(dir, name), "r"));
        } catch {
          // Gone already (a temp file renamed away): fine.
        }
      }
      sleepSync(holdMs);
      for (const handle of handles) closeSync(handle);
    }
    sleepSync(gapMs);
  }
}

const POWERSHELL_HOLDER = `
param([int]$HoldMs, [int]$GapMs, [int]$ParentPid, [string]$Dirs)
$dirList = $Dirs.Split('|')
$round = 0
$ErrorActionPreference = 'SilentlyContinue'
$clock = [Diagnostics.Stopwatch]::StartNew()
function Wait-Ms([double]$ms) { $until = $clock.Elapsed.TotalMilliseconds + $ms; while ($clock.Elapsed.TotalMilliseconds -lt $until) { } }
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $round++
  if (($round % 50) -eq 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
  foreach ($dir in $dirList) {
    $streams = @()
    foreach ($file in [IO.Directory]::GetFiles($dir)) {
      try { $streams += [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite) } catch { }
    }
    Wait-Ms $HoldMs
    foreach ($stream in $streams) { $stream.Dispose() }
  }
  Wait-Ms $GapMs
}
`;

function waitReady(child: ChildProcess, name: string): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`${name} holder did not start: ${output}`)), 30_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("ready")) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} holder exited (${code}): ${output}`));
    });
  });
}

async function startHolders(dirs: string[], holdMs: number, gapMs: number): Promise<{ names: string[]; stop: () => void }> {
  const children: Array<{ name: string; child: ChildProcess }> = [];
  const script = fileURLToPath(import.meta.url);
  children.push({
    name: "node-fs-open-r",
    child: spawn(process.execPath, [script, "--holder", String(process.pid), String(holdMs), String(gapMs), ...dirs], { stdio: ["ignore", "pipe", "pipe"] }),
  });
  if (process.platform === "win32") {
    const scriptPath = join(dirs[0]!, "..", "holder.ps1");
    await writeFile(scriptPath, POWERSHELL_HOLDER, "utf8");
    children.push({
      name: "powershell-fileshare-readwrite",
      child: spawn("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
        "-HoldMs", String(holdMs), "-GapMs", String(gapMs), "-ParentPid", String(process.pid), "-Dirs", dirs.join("|"),
      ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
    });
  }
  const stop = () => {
    for (const { child } of children) {
      child.removeAllListeners("exit");
      child.kill();
    }
  };
  try {
    await Promise.all(children.map(({ name, child }) => waitReady(child, name)));
  } catch (error) {
    stop();
    throw error;
  }
  for (const { child } of children) child.removeAllListeners("exit");
  return { names: children.map(({ name }) => name), stop };
}

function codeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "EUNKNOWN";
}

function count(codes: Record<string, number>, code: string): void {
  codes[code] = (codes[code] ?? 0) + 1;
}

async function main(args: string[]): Promise<number> {
  const saves = flag(args, "--saves", 300);
  const holdMs = flag(args, "--hold-ms", 3);
  const gapMs = flag(args, "--gap-ms", 7);
  const pauseMs = flag(args, "--pause-ms", 2);
  const strict = args.includes("--strict");
  const base = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : tmpdir();
  mkdirSync(base, { recursive: true });
  const root = await mkdtemp(join(base, "omnirush-atomic-write-check-"));
  const controlDir = join(root, "control");
  const fixedDir = join(root, "fixed");
  mkdirSync(controlDir, { recursive: true });
  mkdirSync(fixedDir, { recursive: true });

  // The runtime storage dir is the folder of the (unused) runtime DB, next to configPath.
  delete process.env.OMNIRUSH_RUNTIME_DB;
  const [{ atomicWriteFs }, subagent] = await Promise.all([
    import("../src/atomic-write.js"),
    import("../src/omnirush-subagent-model.js"),
  ]);
  const config = { configPath: join(fixedDir, "server.json") } as unknown as import("../src/types.js").ServerConfig;
  const fixedPath = subagent.subagentModelSettingPath(config);
  if (resolve(fixedPath) !== resolve(join(fixedDir, SETTING_FILE))) throw new Error(`unexpected setting path ${fixedPath}`);
  const controlPath = join(controlDir, SETTING_FILE);

  const values = [
    { model: "gpt-6-sol", effort: "high" },
    { model: "gpt-6-astra", effort: "low" },
  ] as const;
  // Both files exist before the holders start, as they do for a user who saved once.
  await subagent.writeSubagentModelSetting(config, { model: null, effort: null });
  await writeFile(controlPath, `${JSON.stringify({ model: null, effort: null }, null, 2)}\n`, "utf8");

  // Count the transient rename errors the fixed path retried through.
  const retried: Record<string, number> = {};
  const realRename = atomicWriteFs.rename;
  atomicWriteFs.rename = async (from, to) => {
    try {
      await realRename(from, to);
    } catch (error) {
      count(retried, codeOf(error));
      throw error;
    }
  };

  const holders = await startHolders([controlDir, fixedDir], holdMs, gapMs);
  const control = { failures: 0, codes: {} as Record<string, number> };
  const fixed = { failures: 0, codes: {} as Record<string, number>, retriedRenameErrors: retried, messages: [] as string[] };
  let lastControl: string | null = null;
  let lastFixed: unknown = null;
  const started = Date.now();
  try {
    // Control: the pre-fix code (temp file + rename, no retry, no cleanup).
    for (let index = 0; index < saves; index += 1) {
      const content = `${JSON.stringify(values[index % 2], null, 2)}\n`;
      const tmp = `${controlPath}.${process.pid}.${index}.tmp`;
      try {
        await writeFile(tmp, content, "utf8");
        await rename(tmp, controlPath);
        lastControl = content;
      } catch (error) {
        control.failures += 1;
        count(control.codes, codeOf(error));
      }
      if (pauseMs) await new Promise((resolvePause) => setTimeout(resolvePause, pauseMs));
    }
    // Fixed: the real writer.
    for (let index = 0; index < saves; index += 1) {
      const value = values[index % 2]!;
      try {
        lastFixed = await subagent.writeSubagentModelSetting(config, { ...value });
      } catch (error) {
        fixed.failures += 1;
        count(fixed.codes, codeOf(error));
        if (fixed.messages.length < 5) fixed.messages.push(error instanceof Error ? error.message : String(error));
      }
      if (pauseMs) await new Promise((resolvePause) => setTimeout(resolvePause, pauseMs));
    }
  } finally {
    holders.stop();
    atomicWriteFs.rename = realRename;
  }
  // Let the holders' handles close before reading and listing.
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));

  const finalFixed = JSON.parse(await readFile(fixedPath, "utf8")) as unknown;
  const finalControl = await readFile(controlPath, "utf8");
  const fixedLeftovers = (await readdir(fixedDir)).filter((name) => name.endsWith(".tmp"));
  const controlLeftovers = (await readdir(controlDir)).filter((name) => name.endsWith(".tmp"));
  const contentMatches = JSON.stringify(finalFixed) === JSON.stringify(lastFixed);
  const controlReproduced = control.failures > 0;
  const ok = fixed.failures === 0 && contentMatches && fixedLeftovers.length === 0
    && (!strict || process.platform !== "win32" || controlReproduced);

  console.log(JSON.stringify({
    ok,
    platform: process.platform,
    runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
    dir: root,
    holders: holders.names,
    saves,
    holdMs,
    gapMs,
    pauseMs,
    elapsedMs: Date.now() - started,
    control: {
      failures: control.failures,
      codes: control.codes,
      reproduced: controlReproduced,
      finalContentIsLastSaved: finalControl === lastControl,
      leftoverTempFiles: controlLeftovers.length,
    },
    fixed: {
      failures: fixed.failures,
      codes: fixed.codes,
      retriedRenameErrors: fixed.retriedRenameErrors,
      errors: fixed.messages,
      finalContent: finalFixed,
      lastSaved: lastFixed,
      contentMatches,
      leftoverTempFiles: fixedLeftovers,
    },
  }, null, 2));
  return ok ? 0 : 1;
}

const argv = process.argv.slice(2);
if (argv[0] === "--holder") {
  runNodeHolder(Number(argv[1]), argv.slice(4), Number(argv[2]), Number(argv[3]));
} else {
  main(argv).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(2);
    },
  );
}
