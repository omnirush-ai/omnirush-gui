#!/usr/bin/env node
/**
 * Create and push a semantic-version release tag from main. The tag triggers
 * the Desktop Release workflow; source package versions remain untouched.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bumpStableVersion,
  highestStableVersion,
  parseStableVersion,
  readStableTagVersions,
} from "./versions.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const watch = args.includes("--watch");
const versionIndex = args.indexOf("--version");
const explicitVersion = versionIndex >= 0 ? args[versionIndex + 1] : null;
const bumpType = args.find((arg) => ["patch", "minor", "major"].includes(arg)) ?? "patch";
const repo = "omnirush-ai/omnirush-gui";
const workflow = "Desktop Release";

function run(command, commandArgs, options = {}) {
  if (dryRun && options.write) {
    console.log(`[dry-run] ${command} ${commandArgs.join(" ")}`);
    return "";
  }
  const output = execFileSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  return typeof output === "string" ? output.trim() : "";
}

run("gh", ["auth", "status"], { inherit: true });
run("git", ["fetch", "origin", "main", "--tags"]);

const branch = run("git", ["branch", "--show-current"]);
if (branch !== "main") {
  throw new Error(`Releases must be cut from main, not ${branch || "detached HEAD"}.`);
}

const status = run("git", ["status", "--porcelain"]);
if (status) {
  throw new Error("The working tree must be clean before cutting a release.");
}

const localHead = run("git", ["rev-parse", "HEAD"]);
const remoteHead = run("git", ["rev-parse", "origin/main"]);
if (localHead !== remoteHead) {
  throw new Error("main must be fully pushed and match origin/main before releasing.");
}

let version;
if (explicitVersion) {
  if (!parseStableVersion(explicitVersion)) {
    throw new Error(`Invalid --version ${explicitVersion}; expected X.Y.Z.`);
  }
  version = explicitVersion;
} else {
  const latest = highestStableVersion(readStableTagVersions(root));
  version = latest ? bumpStableVersion(latest, bumpType) : "1.0.0";
}

const tag = `v${version}`;
let tagExists = true;
try {
  run("git", ["rev-parse", "--verify", `refs/tags/${tag}`]);
} catch {
  tagExists = false;
}
if (tagExists) throw new Error(`Tag ${tag} already exists.`);

run("git", ["tag", "-a", tag, "-m", `OmniRush.ai ${tag}`], { write: true });
run("git", ["push", "origin", `refs/tags/${tag}`], { write: true, inherit: true });
console.log(`${dryRun ? "Would create" : "Created"} ${tag} at ${localHead}.`);
console.log(`Release: https://github.com/${repo}/releases/tag/${tag}`);

if (watch && !dryRun) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
  const runId = run("gh", [
    "run", "list",
    "--repo", repo,
    "--workflow", workflow,
    "--limit", "1",
    "--json", "databaseId",
    "--jq", ".[0].databaseId",
  ]);
  if (runId) {
    run("gh", ["run", "watch", runId, "--repo", repo, "--exit-status"], { inherit: true });
  }
}
