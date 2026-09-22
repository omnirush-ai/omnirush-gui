#!/usr/bin/env node
// Static import check for packaged desktop builds.
//
// The app archive deliberately excludes server/dist/opencode-plugins/** (the
// plugin bundles ship as extra resources), so a relative import from a server
// module into that folder resolves in development and crashes the installed
// app at startup ("Cannot find module .../opencode-plugins/<file>.js").
// This walks every JavaScript module inside each app.asar and verifies that
// every relative import target exists inside the same archive.
//
// It also verifies that the resources directory next to each app.asar ships
// the bundled UI-control MCP (omnirush-ui-mcp/index.mjs) as a self-contained
// module: the app launches that file with its own binary and never falls back
// to resolving the package from npm.
//
// Usage: node apps/desktop/scripts/verify-packaged-imports.mjs [app.asar ...]
// With no arguments it scans apps/desktop/dist-electron/** for app.asar files.
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";

const { verifyBundledUiMcp } = createRequire(import.meta.url)("./ui-mcp-bundle.cjs");

const here = dirname(fileURLToPath(import.meta.url));
const distElectron = resolve(here, "..", "dist-electron");

function findAsars(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) findAsars(path, out);
    else if (entry.name === "app.asar") out.push(path);
  }
  return out;
}

const importPattern = /(?:^|[\s;])(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["'](\.{1,2}\/[^"'`]+)["']|\bimport\(\s*["'](\.{1,2}\/[^"'`]+)["']\s*\)|\brequire\(\s*["'](\.{1,2}\/[^"'`]+)["']\s*\)/g;
// Workspace packages resolve through their package.json "default" condition
// under Electron's Node, which cannot load .ts files from node_modules.
const workspacePattern = /(?:^|[\s;])(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["'](@omnirush\/[^"'`]+)["']|\bimport\(\s*["'](@omnirush\/[^"'`]+)["']\s*\)/g;

function workspaceTarget(asarPath, files, native, spec) {
  const [, pkg, ...rest] = spec.split("/");
  const manifestPath = `node_modules/@omnirush/${pkg}/package.json`;
  if (!files.has(manifestPath)) return { error: `${manifestPath} missing from archive` };
  let manifest;
  try {
    manifest = JSON.parse(asar.extractFile(asarPath, native.get(manifestPath) ?? manifestPath).toString("utf8"));
  } catch (error) {
    return { error: `${manifestPath} unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const subpath = rest.length ? `./${rest.join("/")}` : ".";
  const entry = manifest.exports?.[subpath] ?? (subpath === "." ? manifest.main : undefined);
  const target = typeof entry === "string" ? entry : entry?.default ?? entry?.import ?? entry?.require;
  if (typeof target !== "string") return { error: `no export for ${subpath}` };
  if (target.endsWith(".ts")) return { error: `${subpath} default -> ${target} (TypeScript source cannot load from node_modules)` };
  const resolved = posix.normalize(posix.join(`node_modules/@omnirush/${pkg}`, target));
  return files.has(resolved) ? {} : { error: `${subpath} -> ${resolved} missing from archive` };
}

function checkAsar(asarPath) {
  // The archive lists paths with the host's separator (backslashes on Windows);
  // compare with forward slashes but extract with the native spelling.
  const native = new Map();
  for (const entry of asar.listPackage(asarPath)) {
    const normalized = entry.replace(/\\/g, "/").replace(/^\//, "");
    native.set(normalized, entry.replace(/^[\\/]/, ""));
  }
  const files = new Set(native.keys());
  // Third-party packages are resolved by Node with their own package.json exports; only first-party modules are checked.
  const modules = [...files].filter((file) => /\.(?:m?js|cjs)$/.test(file) && !/(?:^|\/)node_modules\//.test(file) && !/\.test\.[mc]?js$/.test(file));
  const missing = [];
  for (const file of modules) {
    let source;
    try { source = asar.extractFile(asarPath, native.get(file) ?? file).toString("utf8"); } catch { continue; }
    // Ignore comments so JSDoc type imports such as import("../types") are not treated as runtime imports.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
    for (const match of code.matchAll(importPattern)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec) continue;
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      const candidates = [target, `${target}.js`, `${target}.mjs`, `${target}.cjs`, `${target}/index.js`, `${target}/package.json`];
      if (!candidates.some((candidate) => files.has(candidate))) missing.push(`${file} -> ${spec}`);
    }
    for (const match of code.matchAll(workspacePattern)) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      const { error } = workspaceTarget(asarPath, files, native, spec);
      if (error) missing.push(`${file} -> ${spec}: ${error}`);
    }
  }
  return { modules: modules.length, missing };
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : findAsars(distElectron);
if (targets.length === 0) {
  console.error(`[verify-packaged-imports] no app.asar found under ${distElectron}`);
  process.exit(2);
}
let failed = false;
for (const target of targets) {
  statSync(target);
  const { modules, missing } = checkAsar(target);
  if (missing.length) {
    failed = true;
    console.error(`[verify-packaged-imports] ${target}: ${missing.length} unresolved relative import(s) across ${modules} modules`);
    for (const line of missing) console.error(`  ${line}`);
  } else {
    console.log(`[verify-packaged-imports] ${target}: ${modules} modules, all relative imports resolve inside the archive`);
  }
  const uiMcpProblems = verifyBundledUiMcp(dirname(target));
  if (uiMcpProblems.length) {
    failed = true;
    for (const line of uiMcpProblems) console.error(`[verify-packaged-imports] ${target}: ${line}`);
  } else {
    console.log(`[verify-packaged-imports] ${target}: bundled UI-control MCP is present and self-contained`);
  }
}
process.exit(failed ? 1 : 0);
