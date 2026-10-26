#!/usr/bin/env node
// The GUI and CLI share the Claude account side: access.ts (eligibility, the per-chat relay token) and upload.ts (the native transcript archive).
// Usage: node scripts/sync-claude-capture.mjs /path/to/omnirush-cli [--check]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const [cli, flag] = process.argv.slice(2);
if (!cli || (flag && flag !== "--check")) throw new Error("Expected CLI checkout and optional --check");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (JSON.parse(fs.readFileSync(path.join(cli, "package.json"), "utf8")).name !== "omnirush") throw new Error("Destination is not the CLI checkout");
for (const name of ["access.ts", "upload.ts"]) {
const source = path.join(root, "apps/server/src/claude-code", name);
const target = path.join(path.resolve(cli), "src/claude-code", name);
const bytes = fs.readFileSync(source);
if (flag === "--check") {
  if (!fs.readFileSync(target).equals(bytes)) throw new Error("CLI Claude account files differ; run sync-claude-capture.mjs");
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}
console.log(`${flag === "--check" ? "verified" : "synced"} ${name} ${createHash("sha256").update(bytes).digest("hex")}`);
}
