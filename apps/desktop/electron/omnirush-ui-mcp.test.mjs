import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import YAML from "yaml";

import { bundledOmniRushUiMcpPath, resolveOmniRushUiMcpLaunch } from "./omnirush-ui-mcp.mjs";

const require = createRequire(import.meta.url);
const { nonBuiltinImports, verifyBundledUiMcp } = require("../scripts/ui-mcp-bundle.cjs");

const dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(dirname, "..");
const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "omnirush-ui-mcp-"));
  temporaryRoots.push(root);
  return root;
}

const EXEC_PATH = "/Applications/OmniRush.ai.app/Contents/MacOS/OmniRush.ai";
const RESOURCES = "/Applications/OmniRush.ai.app/Contents/Resources";
const USER_DATA = "/Users/me/Library/Application Support/ai.omnirush.desktop";
const REPO = "/src/omnirush";

describe("UI-control MCP launch command", () => {
  it("launches the bundled resource with the app's own binary in packaged builds", () => {
    const launch = resolveOmniRushUiMcpLaunch({
      devMode: false,
      packaged: true,
      execPath: EXEC_PATH,
      resourcesPath: RESOURCES,
      repoRoot: REPO,
      userDataPath: USER_DATA,
      exists: (filePath) => filePath === bundledOmniRushUiMcpPath(RESOURCES),
    });
    assert.deepEqual(launch, {
      command: [EXEC_PATH, path.join(RESOURCES, "omnirush-ui-mcp", "index.mjs")],
      environment: {
        ELECTRON_RUN_AS_NODE: "1",
        OMNIRUSH_UI_CONTROL_DISCOVERY: path.join(USER_DATA, "omnirush-ui-control.json"),
      },
    });
    assert.ok(!launch.command.includes("npx"));
  });

  it("fails closed instead of falling back to npx when the bundle is missing", () => {
    assert.throws(
      () => resolveOmniRushUiMcpLaunch({
        devMode: false,
        packaged: true,
        execPath: EXEC_PATH,
        resourcesPath: RESOURCES,
        repoRoot: REPO,
        userDataPath: USER_DATA,
        exists: () => false,
      }),
      /missing from this build/,
    );
    assert.throws(
      () => resolveOmniRushUiMcpLaunch({
        devMode: false,
        packaged: true,
        execPath: EXEC_PATH,
        resourcesPath: null,
        repoRoot: REPO,
        userDataPath: USER_DATA,
        exists: () => true,
      }),
      /missing from this build/,
    );
  });

  it("keeps the dev-mode checkout path under the developer's node", () => {
    const launch = resolveOmniRushUiMcpLaunch({
      devMode: true,
      packaged: false,
      execPath: "/repo/node_modules/electron/dist/Electron",
      resourcesPath: "/repo/node_modules/electron/dist/Resources",
      repoRoot: REPO,
      userDataPath: USER_DATA,
      exists: () => false,
    });
    assert.deepEqual(launch.command, ["node", path.join(REPO, "packages", "omnirush-ui-mcp", "index.mjs")]);
    assert.equal(launch.environment.ELECTRON_RUN_AS_NODE, undefined);
  });

  it("runs the checkout source under this Electron binary for unpackaged non-dev launches", () => {
    const electronBinary = "/repo/node_modules/electron/dist/Electron";
    const launch = resolveOmniRushUiMcpLaunch({
      devMode: false,
      packaged: false,
      execPath: electronBinary,
      resourcesPath: "/repo/node_modules/electron/dist/Resources",
      repoRoot: REPO,
      userDataPath: USER_DATA,
      exists: () => true,
    });
    assert.deepEqual(launch.command, [electronBinary, path.join(REPO, "packages", "omnirush-ui-mcp", "index.mjs")]);
    assert.equal(launch.environment.ELECTRON_RUN_AS_NODE, "1");
  });

  it("no longer references the unpublished npm package from the main process", () => {
    const main = readFileSync(path.join(dirname, "main.mjs"), "utf8");
    assert.doesNotMatch(main, /["']npx["']/);
    assert.doesNotMatch(main, /["']omnirush-ui-mcp["']\s*\]/);
  });
});

describe("bundled UI-control MCP packaging", () => {
  it("ships the bundle as an extra resource on every platform", async () => {
    const config = YAML.parse(readFileSync(path.join(desktopRoot, "electron-builder.base.yml"), "utf8"));
    assert.ok(config.extraResources.some((entry) => (
      entry.from === ".electron-runtime/omnirush-ui-mcp"
      && entry.to === "omnirush-ui-mcp"
      && entry.filter?.includes("index.mjs")
    )));
    const build = readFileSync(path.join(desktopRoot, "scripts", "electron-build.mjs"), "utf8");
    assert.match(build, /prepare-ui-mcp\.mjs/);
  });

  it("rejects bundles that still import npm packages", () => {
    assert.deepEqual(nonBuiltinImports([
      'import { readFile } from "node:fs/promises";',
      'import process2 from "node:process";',
      'const codegen = `require("ajv/dist/runtime/equal").default`;',
    ].join("\n")), []);
    assert.deepEqual(nonBuiltinImports([
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'import { z } from "zod";',
      'const lazy = await import("undici");',
    ].join("\n")), ["@modelcontextprotocol/sdk/server/mcp.js", "undici", "zod"]);
  });

  it("verify-packaged-imports fails the build when the bundled MCP is missing", async () => {
    const root = temporaryRoot();
    const appSource = path.join(root, "app-source");
    mkdirSync(appSource, { recursive: true });
    writeFileSync(path.join(appSource, "package.json"), JSON.stringify({ name: "fixture", main: "main.mjs" }));
    writeFileSync(path.join(appSource, "main.mjs"), 'import "./helper.mjs";\n');
    writeFileSync(path.join(appSource, "helper.mjs"), "export {};\n");
    const resources = path.join(root, "Resources");
    mkdirSync(resources, { recursive: true });
    const archive = path.join(resources, "app.asar");
    await asar.createPackage(appSource, archive);
    const verifier = path.join(desktopRoot, "scripts", "verify-packaged-imports.mjs");

    const missing = spawnSync(process.execPath, [verifier, archive], { encoding: "utf8" });
    assert.equal(missing.status, 1, missing.stdout);
    assert.match(missing.stderr, /missing bundled UI-control MCP/);
    assert.deepEqual(verifyBundledUiMcp(resources).length, 1);

    mkdirSync(path.join(resources, "omnirush-ui-mcp"), { recursive: true });
    writeFileSync(path.join(resources, "omnirush-ui-mcp", "index.mjs"), 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\n');
    const unbundled = spawnSync(process.execPath, [verifier, archive], { encoding: "utf8" });
    assert.equal(unbundled.status, 1, unbundled.stdout);
    assert.match(unbundled.stderr, /imports packages that are not shipped: @modelcontextprotocol\/sdk\/server\/mcp\.js/);

    writeFileSync(path.join(resources, "omnirush-ui-mcp", "index.mjs"), 'import { readFile } from "node:fs/promises";\nvoid readFile;\n');
    const present = spawnSync(process.execPath, [verifier, archive], { encoding: "utf8" });
    assert.equal(present.status, 0, present.stderr);
    assert.match(present.stdout, /bundled UI-control MCP is present and self-contained/);
  });
});
