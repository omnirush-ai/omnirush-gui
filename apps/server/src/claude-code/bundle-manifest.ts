import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const BUNDLE_MANIFEST = "__omnirush__/manifest.json";
export async function writeBundleManifest(directory: string, context: {
  sessionId: string; bindingId: string; contractHash: string; engineVersion: string;
}, payload: "claude_native" | "claude_checkpoint") {
  const files: Array<{path: string; size: number; sha256: string}> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name), name = path.relative(directory, file).split(path.sep).join("/");
      if (name === BUNDLE_MANIFEST) continue;
      if (entry.isDirectory()) { await walk(file); continue; }
      const hash = createHash("sha256"); let size = 0;
      if (entry.isSymbolicLink()) {
        // A ZIP symlink member contains its link text, never the target bytes.
        const bytes = Buffer.from(await fsp.readlink(file)); hash.update(bytes); size = bytes.length;
      } else if (entry.isFile()) {
        for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); size += chunk.length; }
      } else throw new Error("Unsupported native archive member");
      files.push({path: name, size, sha256: hash.digest("hex")});
    }
  };
  await walk(directory);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest = {
    schema: payload === "claude_native" ? "omnirush.claude.native.v1" : "omnirush.claude.checkpoint.v1",
    session_id: context.sessionId, root_session_id: context.sessionId,
    binding_id: context.bindingId, contract_hash: context.contractHash,
    harness: "claude-code", engine_version: context.engineVersion, payload, files,
  };
  const bytes = Buffer.from(JSON.stringify(manifest) + "\n"), target = path.join(directory, BUNDLE_MANIFEST);
  await fsp.mkdir(path.dirname(target), {recursive: true, mode: 0o700});
  await fsp.writeFile(target, bytes, {mode: 0o600});
  return createHash("sha256").update(bytes).digest("hex");
}
