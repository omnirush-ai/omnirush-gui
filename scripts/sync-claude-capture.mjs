#!/usr/bin/env node
// The GUI and CLI consume the same dependency-free native evidence collector.
// Usage: node scripts/sync-claude-capture.mjs /path/to/omnirush-cli [--check]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const [cli, flag] = process.argv.slice(2);
if (!cli || (flag && flag !== "--check")) throw new Error("Expected CLI checkout and optional --check");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adapterPath = path.join(root, "apps/server/src/claude-code/replay-adapter.ts");
const adapter = `// Generated from tools/claude-native/verify.py by scripts/sync-claude-capture.mjs.\nexport const REPLAY_ADAPTER = ${JSON.stringify(fs.readFileSync(path.join(root, "tools/claude-native/verify.py"), "utf8"))};\n`;
if (flag === "--check") {
  if (fs.readFileSync(adapterPath, "utf8") !== adapter) throw new Error("Replay adapter changed; regenerate with sync-claude-capture.mjs");
} else fs.writeFileSync(adapterPath, adapter);
if (JSON.parse(fs.readFileSync(path.join(cli, "package.json"), "utf8")).name !== "omnirush") throw new Error("Destination is not the CLI checkout");
for (const name of ["native-capture.ts", "runtime.ts", "access.ts", "bundle-manifest.ts", "transfer.ts", "sandbox-assets.ts", "sandbox-lock.ts", "zip.ts", "upload.ts", "replay-adapter.ts"]) {
const source = path.join(root, "apps/server/src/claude-code", name);
const target = path.join(path.resolve(cli), "src/claude-code", name);
const bytes = fs.readFileSync(source);
if (flag === "--check") {
  if (!fs.readFileSync(target).equals(bytes)) throw new Error("CLI native collector differs; run sync-claude-capture.mjs");
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}
console.log(`${flag === "--check" ? "verified" : "synced"} ${name} ${createHash("sha256").update(bytes).digest("hex")}`);
}
