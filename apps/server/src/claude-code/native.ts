// After each Claude turn: the chat's native Claude Code transcript, unchanged, as `claude/` members
// of a `claude_native` archive of the same session (upload.ts, archive spec 20). The same as the
// CLI's src/claude-code/native.ts. No environment snapshot (phase 1): the chat's own archive carries the project.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import type { ClaudeGrant } from "./access.js";
import { parseNativeCaptureCapabilities, uploadNativeBundle, type NativeArchiveDriver, type NativeUploadReceipt, type NativeUploadRequest } from "./upload.js";

const MANIFEST = "__omnirush__/manifest.json";

async function sha256(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** The chat's transcript files in Claude's config folder: `<uuid>.jsonl` and its `<uuid>/` (sub-agents), as `claude/…` names. */
export function transcriptFiles(configDir: string, uuid: string): { name: string; file: string }[] {
  const out: { name: string; file: string }[] = [];
  const projects = path.join(configDir, "projects");
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(projects); } catch { return out; }
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push({ name: `claude/${path.relative(configDir, full).split(path.sep).join("/")}`, file: full });
    }
  };
  for (const dir of dirs) {
    const main = path.join(projects, dir, `${uuid}.jsonl`);
    if (fs.existsSync(main)) out.push({ name: `claude/projects/${dir}/${uuid}.jsonl`, file: main });
    if (fs.existsSync(path.join(projects, dir, uuid))) walk(path.join(projects, dir, uuid));
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The box run folder's Claude config holding `uuid` (each project's box has its own): <boxHome>/projects/<key>/claude/config. */
export function claudeConfigDirOf(boxHome: string, uuid: string): string | null {
  let keys: string[] = [];
  try { keys = fs.readdirSync(path.join(boxHome, "projects")); } catch { return null; }
  for (const key of keys) {
    const configDir = path.join(boxHome, "projects", key, "claude", "config");
    if (transcriptFiles(configDir, uuid).length) return configDir;
  }
  return null;
}

/** One turn's native upload: a staged copy (the box may write on) with its manifest, sealed and sent; the staged copy is removed after. */
export async function uploadClaudeTurn({ grant, uuid, configDir, stateDir, engineVersion, request, driver }: {
  grant: ClaudeGrant; uuid: string; configDir: string; stateDir: string; engineVersion: string; request: NativeUploadRequest; driver: NativeArchiveDriver;
}): Promise<NativeUploadReceipt | { status: "skipped"; reason: string }> {
  const files = transcriptFiles(configDir, uuid);
  if (!files.length) return { status: "skipped", reason: "no_transcript" };
  const response = await request("collect/capabilities", { method: "GET" });
  const value: { claude_code?: { capture?: unknown } } | null = response.ok ? await response.json() : null;
  const capabilities = parseNativeCaptureCapabilities(value?.claude_code?.capture);
  if (!capabilities) return { status: "skipped", reason: "capture_not_offered" };
  capabilities.checkpoint.enabled = false;
  const home = path.join(stateDir, "claude-native", grant.sessionId);
  const stage = path.join(home, `stage-${process.pid}`);
  await fsp.rm(stage, { recursive: true, force: true });
  try {
    const listed: { path: string; size: number; sha256: string }[] = [];
    for (const { name, file } of files) {
      const target = path.join(stage, ...name.split("/"));
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fsp.copyFile(file, target);
      listed.push({ path: name, size: (await fsp.stat(target)).size, sha256: await sha256(target) });
    }
    const manifest = { schema: "omnirush.claude.native.v1", session_id: grant.sessionId, root_session_id: grant.sessionId, binding_id: grant.bindingId,
      contract_hash: grant.contractSha256, harness: "claude-code", engine_version: engineVersion, payload: "claude_native", claude_session_id: uuid, files: listed };
    await fsp.mkdir(path.join(stage, "__omnirush__"), { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(stage, ...MANIFEST.split("/")), JSON.stringify(manifest), { mode: 0o600 });
    const prior = fs.existsSync(path.join(home, "claude_native")) ? fs.readdirSync(path.join(home, "claude_native")).filter((n) => /^[0-9a-f]{64}\.json$/.test(n)).length : 0;
    const receipt = await uploadNativeBundle({
      sessionId: grant.sessionId, owner: grant.owner, turn: prior, bindingId: grant.bindingId, contractHash: grant.contractSha256, engineVersion,
      nativeDirectory: stage, stateDirectory: home, capabilities, driver,
    });
    if (receipt.native.status === "uploaded" && receipt.native.archiveId) await fsp.rm(path.join(home, "claude_native", `${receipt.native.archiveId}.orseal`), { force: true });
    return receipt;
  } finally {
    await fsp.rm(stage, { recursive: true, force: true });
  }
}
