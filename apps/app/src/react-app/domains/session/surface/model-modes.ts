// Per-model modes in the app. A chat's model is fixed when it starts (its
// sub-agents and compactions use it too). A new chat may start on a model the
// project's mode allows, or, in a sandbox project, on a model that runs only
// outside the sandbox (Kimi): that chat then runs on this computer, exempt
// from the required sandbox (box/service.ts beforePrompt nativeModel). A model
// that runs only in the sandbox is never offered outside it. The server lists
// each catalog model's `modes`
// (GET /omnirush/subagent-model, normalized from the backend's catalog by the
// shared apps/server/src/model-modes/model-modes.mjs: no `modes` means both).
// The gateway broker sends X-OmniRush-Box for box chats and refuses a model
// outside the chat's mode before it leaves this computer.
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import type { ModelRef } from "@/app/types";
import type { OmniRushSubagentModelState } from "@/app/lib/omnirush-server";
import { useLinuxSandbox, type LinuxSandboxClient } from "@/react-app/domains/settings/linux-sandbox";
import { useSubagentModel, type SubagentModelClient } from "@/react-app/domains/settings/subagent-model";
import { getReactQueryClient } from "@/react-app/infra/query-client";

type CatalogModels = OmniRushSubagentModelState["models"];
type Mode = "native" | "box";

/** Whether `model` may run in `mode`: any other provider's, an unknown model, or one listing the mode. */
export function modeAllowsModel(models: CatalogModels | undefined, mode: Mode | null, model: ModelRef | null | undefined): boolean {
  if (!mode || !model || model.providerID !== "omnirush") return true;
  const entry = models?.find((candidate) => candidate.id === model.modelID);
  return !entry?.modes || entry.modes.includes(mode);
}

/**
 * Whether a NEW chat in a project in `mode` may start on `model`: one its mode
 * allows, or in a sandbox project one that runs only on this computer (the
 * chat then runs here).
 */
export function newChatAllowsModel(models: CatalogModels | undefined, mode: Mode | null, model: ModelRef | null | undefined, work = false): boolean {
  // The omnirush-claude provider runs a Work chat with none of Work's tools, rules or prompt.
  if (work && model?.providerID === "omnirush-claude") return false;
  if (modeAllowsModel(models, mode, model)) return true;
  return mode === "box" && modeAllowsModel(models, "native", model);
}

/** The model a new chat in `mode` starts on instead of `model`: the catalog default among the allowed ones, else the first allowed. */
export function modeFallbackModel(models: CatalogModels | undefined, mode: Mode | null, model: ModelRef | null | undefined, work = false): ModelRef | null {
  if (newChatAllowsModel(models, mode, model, work)) return model ?? null;
  const allowed = (models ?? []).filter((entry) => newChatAllowsModel(models, mode, { providerID: "omnirush", modelID: entry.id }));
  const pick = allowed.find((entry) => entry.default) ?? allowed[0];
  return pick ? { providerID: "omnirush", modelID: pick.id } : null;
}

/** "Kimi K3.1 Pro isn't available in sandbox projects. Using GPT 6 Astra here." */
export function modeSwitchNote(models: CatalogModels | undefined, mode: Mode, from: ModelRef, to: ModelRef): string {
  const name = (ref: ModelRef) => models?.find((entry) => entry.id === ref.modelID)?.name ?? ref.modelID;
  return `${name(from)} isn't available ${mode === "box" ? "in sandbox projects" : "outside the sandbox"}. Using ${name(to)} here.`;
}

/**
 * Whether a started chat on `current` may go on with `next`: two catalog
 * models of one provider (`switch_group`, the server's grouping). A model with
 * no group (Claude, an older server) is a new chat. Mirrors
 * apps/server/src/model-modes/strict-sessions.mjs switchableModels.
 */
export function switchableModel(models: CatalogModels | undefined, current: ModelRef, next: ModelRef): boolean {
  if (current.providerID !== "omnirush" || next.providerID !== "omnirush") return false;
  const group = (id: string) => models?.find((entry) => entry.id === id)?.switch_group ?? null;
  const first = group(current.modelID);
  return first !== null && first === group(next.modelID);
}

/** "This chat runs on Kimi K3.1 Pro. Start a new chat to use GPT 6 Astra." */
export function fixedModelNote(models: CatalogModels | undefined, current: ModelRef, wanted: ModelRef): string {
  const name = (ref: ModelRef) => models?.find((entry) => entry.id === ref.modelID)?.name ?? ref.modelID;
  return `This chat runs on ${name(current)}. Start a new chat to use ${name(wanted)}.`;
}

/** "This chat runs on Kimi K3.1 Pro, which isn't available in sandbox projects. Start a new chat." */
export function chatModeNote(models: CatalogModels | undefined, mode: Mode, model: ModelRef): string {
  const name = models?.find((entry) => entry.id === model.modelID)?.name ?? model.modelID;
  return `This chat runs on ${name}, which isn't available ${mode === "box" ? "in sandbox projects" : "outside the sandbox"}. Start a new chat.`;
}

const STARTED_KEY = "omnirush.sessionModelFixed";

/** Chats that sent a prompt: their model is fixed (one model per chat). */
export function chatStarted(sessionId: string | null | undefined): boolean {
  if (!sessionId || typeof window === "undefined") return false;
  try {
    if ((JSON.parse(window.localStorage.getItem(STARTED_KEY) ?? "[]") as unknown[]).includes(sessionId)) return true;
  } catch { /* the engine's messages still say */ }
  return engineHasPrompt(sessionId);
}

/**
 * Whether the engine's messages this app holds for a chat (its transcript or
 * snapshot, session-sync.ts) hold a prompt: a chat started before chats were
 * marked here, or on another install, is started too.
 */
function engineHasPrompt(sessionId: string): boolean {
  const cache = getReactQueryClient();
  for (const root of ["react-session-transcript", "react-session-snapshot"]) {
    for (const [key, data] of cache.getQueriesData<unknown>({ queryKey: [root] })) {
      if (key[2] !== sessionId) continue;
      const messages = Array.isArray(data) ? data : (data as { messages?: unknown } | undefined)?.messages;
      if (!Array.isArray(messages)) continue;
      if (messages.some((message: { role?: unknown; info?: { role?: unknown } } | null) => (message?.role ?? message?.info?.role) === "user")) return true;
    }
  }
  return false;
}

export function markChatStarted(sessionId: string): void {
  if (typeof window === "undefined" || chatStarted(sessionId)) return;
  try {
    const ids = (JSON.parse(window.localStorage.getItem(STARTED_KEY) ?? "[]") as unknown[]).filter((id): id is string => typeof id === "string");
    window.localStorage.setItem(STARTED_KEY, JSON.stringify([...ids, sessionId].slice(-2000)));
  } catch {
    // quota: the broker still keeps the chat on its model
  }
}

/**
 * The open project's rule for every model list the app shows (the composer's
 * model menu, the model picker): set by the session route, all models while
 * no project mode is known.
 */
export const useModelModeFilter = create<{ allows: (model: ModelRef | null | undefined) => boolean }>(() => ({ allows: () => true }));

/**
 * The mode of the open project (or chat: one kept on this computer when the
 * sandbox became required stays native) and its model rules. `mode` is null
 * until the project's sandbox state is known: nothing is filtered meanwhile.
 */
export function useProjectModelModes(
  client: (LinuxSandboxClient & SubagentModelClient) | null,
  workspaceId: string | null,
  sessionId: string | null,
  /** A Work chat (or the Work home's composer): no omnirush-claude models. */
  work = false,
) {
  const sandbox = useLinuxSandbox(client, workspaceId, { fresh: false, sessionId });
  const { state } = useSubagentModel(client);
  const box = sandbox.box;
  const mode: Mode | null = box ? (box.on && !box.chatKept ? "box" : "native") : null;
  const models = state?.models;
  const rules = useMemo(() => ({
    mode,
    /** An existing chat's model in the chat's own mode. */
    allows: (model: ModelRef | null | undefined) => modeAllowsModel(models, mode, model),
    /** What a new chat may start on (the pickers' list). */
    allowsNew: (model: ModelRef | null | undefined) => newChatAllowsModel(models, mode, model, work),
    fallback: (model: ModelRef | null | undefined) => modeFallbackModel(models, mode, model, work),
    note: (from: ModelRef, to: ModelRef) => work && from.providerID === "omnirush-claude"
      ? `Claude isn't available in Work chats. Using ${models?.find((entry) => entry.id === to.modelID)?.name ?? to.modelID} here.`
      : modeSwitchNote(models, mode ?? "native", from, to),
    fixedNote: (current: ModelRef, wanted: ModelRef) => fixedModelNote(models, current, wanted),
    /** A started chat may go on with `next` (same provider). */
    switchable: (current: ModelRef, next: ModelRef) => switchableModel(models, current, next),
    chatNote: (model: ModelRef) => chatModeNote(models, mode ?? "native", model),
  }), [mode, models, work]);
  useEffect(() => {
    useModelModeFilter.setState({ allows: rules.allowsNew });
  }, [rules]);
  useEffect(() => () => useModelModeFilter.setState({ allows: () => true }), []);
  return rules;
}
