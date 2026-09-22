// Bundle the built-in UI-control MCP (packages/omnirush-ui-mcp) into one
// self-contained ES module that electron-builder ships as an extra resource
// (<resources>/omnirush-ui-mcp/index.mjs). The packaged app launches it with its
// own Electron binary in Node mode, so the bundle may import only Node
// built-ins: every npm dependency is inlined here, at build time.
//
// Usage: node scripts/prepare-ui-mcp.mjs [--outdir <dir>]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { verifyUiMcpBundleFile, UI_MCP_ENTRY } = createRequire(import.meta.url)("./ui-mcp-bundle.cjs");

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptsDir, "..");
const repoRoot = resolve(desktopRoot, "../..");
const entry = resolve(repoRoot, "packages", "omnirush-ui-mcp", "index.mjs");
const defaultOutdir = resolve(desktopRoot, ".electron-runtime", "omnirush-ui-mcp");

function parseOutdir(argv) {
  const index = argv.indexOf("--outdir");
  return index >= 0 && argv[index + 1] ? resolve(argv[index + 1]) : defaultOutdir;
}

export function prepareUiMcp(outdir = defaultOutdir) {
  if (!existsSync(entry)) throw new Error(`UI-control MCP entry is missing: ${entry}`);
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  const outfile = join(outdir, UI_MCP_ENTRY);
  // Bun already builds the server's OpenCode plugins; CI installs it for every
  // desktop packaging job.
  const result = spawnSync("bun", [
    "build",
    entry,
    "--target", "node",
    "--format", "esm",
    "--outfile", outfile,
  ], { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`bun build failed for the UI-control MCP (status ${result.status}).`);

  const problems = verifyUiMcpBundleFile(outfile);
  if (problems.length) throw new Error(problems.join("\n"));
  const check = spawnSync(process.execPath, ["--check", outfile], { stdio: "inherit" });
  if (check.status !== 0) throw new Error("The UI-control MCP bundle failed node --check.");
  return outfile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outfile = prepareUiMcp(parseOutdir(process.argv.slice(2)));
  process.stdout.write(`[prepare-ui-mcp] bundled ${outfile}\n`);
}
