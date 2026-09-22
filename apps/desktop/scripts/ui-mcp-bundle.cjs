// Shared checks for the bundled UI-control MCP resource. Used by the bundler
// (prepare-ui-mcp.mjs), the electron-builder afterPack hook, and
// verify-packaged-imports.mjs so a package without a runnable bundle fails the
// build instead of shipping a UI-control extension that cannot start.
const fs = require("node:fs");
const path = require("node:path");

const UI_MCP_RESOURCE_DIR = "omnirush-ui-mcp";
const UI_MCP_ENTRY = "index.mjs";

/** Module specifiers the bundle imports statically or dynamically. */
function bundleImportSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    /^\s*export\s+[^"';]*?\s+from\s+["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

/** Everything the bundle imports must be a Node built-in: npm packages are inlined at build time. */
function nonBuiltinImports(source) {
  return bundleImportSpecifiers(source).filter((specifier) => !specifier.startsWith("node:"));
}

function bundledUiMcpPath(resourcesDir) {
  return path.join(resourcesDir, UI_MCP_RESOURCE_DIR, UI_MCP_ENTRY);
}

/** Problems with the bundled UI-control MCP under a packaged resources directory; empty when it is shippable. */
function verifyBundledUiMcp(resourcesDir) {
  return verifyUiMcpBundleFile(bundledUiMcpPath(resourcesDir));
}

/** Problems with one bundled UI-control MCP file; empty when it is shippable. */
function verifyUiMcpBundleFile(bundlePath) {
  let source;
  try {
    source = fs.readFileSync(bundlePath, "utf8");
  } catch {
    return [`missing bundled UI-control MCP at ${bundlePath}`];
  }
  if (!source.trim()) return [`empty bundled UI-control MCP at ${bundlePath}`];
  const external = nonBuiltinImports(source);
  if (external.length) {
    return [`bundled UI-control MCP at ${bundlePath} imports packages that are not shipped: ${external.join(", ")}`];
  }
  return [];
}

module.exports = {
  UI_MCP_ENTRY,
  UI_MCP_RESOURCE_DIR,
  bundleImportSpecifiers,
  bundledUiMcpPath,
  nonBuiltinImports,
  verifyBundledUiMcp,
  verifyUiMcpBundleFile,
};
