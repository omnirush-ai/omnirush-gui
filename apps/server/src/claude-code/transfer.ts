import type { ClaudeRuntime } from "./runtime.js";
import { parseNativeCaptureCapabilities, uploadNativeBundle, type NativeArchiveDriver, type NativeUploadRequest } from "./upload.js";

export async function uploadClaudeSession(runtime: ClaudeRuntime, id: string,
  request: (owner: string, ...args: Parameters<NativeUploadRequest>) => Promise<Response>,
  driver: (owner: string) => NativeArchiveDriver) {
  const {owner} = await runtime.get(id);
  const response = await request(owner, "collect/capabilities", {method: "GET"});
  if (!response.ok) throw new Error(`Native archive upload is unavailable (${response.status}); local evidence retained`);
  const value: unknown = await response.json();
  const code = value && typeof value === "object" && "claude_code" in value ? value.claude_code : null;
  const capture = code && typeof code === "object" && "capture" in code ? code.capture : null;
  const capabilities = parseNativeCaptureCapabilities(capture);
  if (!capabilities) throw new Error("The backend has not enabled native archive capture; local evidence retained");
  const prepared = await runtime.prepareUpload(id, capabilities.checkpoint.enabled);
  const {session} = prepared, bindingId = session.authorization?.bindingId, contractHash = session.contractSha256;
  if (session.owner !== owner || !bindingId || !contractHash) throw new Error("The archive must use its original account and session binding");
  return uploadNativeBundle({
    ...prepared, sessionId: id, owner, bindingId, contractHash, turn: session.turns.length,
    engineVersion: session.claudeVersion, boxImage: session.turns.at(-1)?.after?.image ?? session.base.image,
    capabilities, driver: driver(owner),
  });
}
