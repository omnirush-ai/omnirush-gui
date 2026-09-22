/**
 * OmniRush.ai Reasoning Effort Plugin
 *
 * omnirush.ai models expose their effort levels as engine variants
 * (low / high / xhigh / max) whose options carry the client-facing
 * `reasoning_effort` value. The bundled OpenAI Responses adapter only reads
 * the camel-case `reasoningEffort` option, and it only emits
 * `reasoning.effort` for model ids it recognises as reasoning models, so the
 * selected level could silently disappear before the request leaves the
 * engine. This plugin keeps the selection on the wire by
 *
 *   1. mirroring the variant's effort into `reasoningEffort`, so the adapter
 *      emits `reasoning.effort` wherever it can, and
 *   2. tagging the request with a private header that the local gateway
 *      broker turns into `reasoning.effort` when the body still lacks one.
 *
 * The header never leaves the machine: the broker only forwards an explicit
 * allow-list of headers to omnirush.ai.
 */
const PROVIDER_ID = "omnirush";
/** Read by OmniRushGatewayBroker; keep the two definitions identical. */
const EFFORT_HEADER = "x-omnirush-reasoning-effort";
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"]);
/** Cheap side requests never carry the conversation's effort selection. */
const SKIPPED_AGENTS = new Set(["title"]);
const MAX_PENDING = 512;

type HookInput = {
  agent?: string;
  model: { id: string; providerID: string };
  message?: { id?: string; model?: { variant?: string } };
};

// chat.params sees the merged variant options; chat.headers runs right after
// it for the same user message and only sees the message. Bridge the two by
// message id so both hooks describe the same effort.
const pending = new Map<string, string>();

function normalizeEffort(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const effort = value.trim().toLowerCase();
  return EFFORTS.has(effort) ? effort : null;
}

function isInternalModel(input: HookInput): boolean {
  return input.model.providerID.trim().toLowerCase() === PROVIDER_ID
    && !SKIPPED_AGENTS.has(input.agent ?? "");
}

function optionEffort(options: Record<string, unknown>): string | null {
  return normalizeEffort(options.reasoningEffort) ?? normalizeEffort(options.reasoning_effort);
}

function remember(messageId: string | undefined, effort: string): void {
  if (!messageId) return;
  if (pending.size >= MAX_PENDING) pending.clear();
  pending.set(messageId, effort);
}

function recall(input: HookInput): string | null {
  const messageId = input.message?.id;
  const bridged = messageId ? pending.get(messageId) : undefined;
  if (messageId) pending.delete(messageId);
  return bridged ?? normalizeEffort(input.message?.model?.variant);
}

// Single export: the OpenCode plugin loader treats every export of a plugin
// module as a plugin factory, so helpers must stay module-private.
export const OmniRushReasoningEffort = async () => ({
  "chat.params": async (input: HookInput, output: { options: Record<string, unknown> }) => {
    if (!isInternalModel(input)) return;
    const effort = optionEffort(output.options) ?? normalizeEffort(input.message?.model?.variant);
    if (!effort) return;
    if (normalizeEffort(output.options.reasoningEffort) !== effort) output.options.reasoningEffort = effort;
    remember(input.message?.id, effort);
  },
  "chat.headers": async (input: HookInput, output: { headers: Record<string, string> }) => {
    if (!isInternalModel(input)) return;
    const effort = recall(input);
    if (effort) output.headers[EFFORT_HEADER] = effort;
  },
});
