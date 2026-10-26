// Claude in the model picker. The server's capability `claude_code` lists the
// Claude models: `catalog` (what every account sees) and `models` (what this
// account may run); the local server passes both through
// GET /workspace/:id/claude/status. Claude is a model of the chat engine's
// "omnirush-claude" provider: each turn runs Claude Code in the project's
// sandbox (opencode-plugins/claude-provider), so picking it sets the project's
// sandbox up first. A chat keeps one model; another pick in a chat that
// already ran offers a new chat instead.
import { useEffect } from "react";
import { create } from "zustand";

import type { ModelRef } from "@/app/types";
import type { OmniRushServerClient, OmniRushWorkspaceBox, OmniRushWorkspaceBoxSetupAction } from "@/app/lib/omnirush-server";

export type ClaudeCatalogEntry = { id: string; name: string };
export type ClaudeModelsState = {
  workspaceId: string | null;
  catalog: ClaudeCatalogEntry[];
  /** The ids this account may run. */
  models: string[];
  /** Why none may run (the capability's access.reason), null while some may. */
  reason: string | null;
};

const CLAUDE_ID = /^claude-[a-z0-9][a-z0-9.-]{0,62}$/;
const EMPTY: ClaudeModelsState = { workspaceId: null, catalog: [], models: [], reason: null };

export const useClaudeModels = create<ClaudeModelsState>(() => EMPTY);

export const CLAUDE_PROVIDER_ID = "omnirush-claude";

/** A Claude model of the picker: the engine's Claude provider. */
export function isClaudeModel(model: ModelRef | null | undefined): boolean {
  return model?.providerID === CLAUDE_PROVIDER_ID;
}

export function claudeModelName(state: Pick<ClaudeModelsState, "catalog">, id: string): string {
  return state.catalog.find((entry) => entry.id === id)?.name ?? id;
}

/** "Claude Sonnet 5.5 isn't available on your account yet." */
export function claudeUnavailableMessage(name: string, reason: string | null): string {
  if (reason === "client_outdated") return `${name} needs the latest OmniRush. Update the app to use it.`;
  if (reason === "account_not_usable") return `${name} isn't available while your account is paused.`;
  if (reason === "claude_off") return `${name} isn't available right now. Try again later.`;
  return `${name} isn't available on your account yet.`;
}

export type ModelPick =
  | { kind: "same" }
  | { kind: "switch" }
  | { kind: "claude" }
  | { kind: "new_chat" }
  | { kind: "unavailable"; message: string };

/**
 * What picking `next` does. `current` is the chat's model and `started` says it
 * already ran (its provider is fixed). An unavailable Claude model is explained
 * first, wherever it is picked; a model of another provider in a started chat
 * offers a new chat, one of its provider (`switchable`, model-modes.ts
 * switchableModel) is switched to; in a fresh chat a Claude model is switched
 * to once the project's sandbox is set up, any other model at once.
 */
export function decideModelPick(input: { next: ModelRef; current: ModelRef | null; started: boolean; claude: ClaudeModelsState; switchable?: (current: ModelRef, next: ModelRef) => boolean }): ModelPick {
  const { next, current, started, claude, switchable } = input;
  const same = Boolean(current && current.providerID === next.providerID && current.modelID === next.modelID);
  if (same) return { kind: "same" };
  if (isClaudeModel(next) && !claude.models.includes(next.modelID)) {
    return { kind: "unavailable", message: claudeUnavailableMessage(claudeModelName(claude, next.modelID), claude.reason) };
  }
  if (started && current && !(switchable?.(current, next) ?? false)) return { kind: "new_chat" };
  return isClaudeModel(next) ? { kind: "claude" } : { kind: "switch" };
}

/** "Start a new chat with Claude Sonnet 5.5?" and why. */
export function newChatPrompt(currentName: string, nextName: string): { title: string; message: string } {
  return {
    title: `Start a new chat with ${nextName}?`,
    message: `This chat runs on ${currentName}, and a chat keeps one model. A new chat on ${nextName} starts in this project; this chat stays as it is.`,
  };
}

/**
 * The next step that sets this project's sandbox up for Claude, the same steps
 * the required sandbox takes (Settings' sandbox card, the composer chip):
 * "on" turns the project's sandbox on; a setup action runs this computer's
 * own setup (Linux user namespaces, the Windows WSL install; the macOS VM
 * sets itself up once on); null: nothing to do (on and set up, or it cannot run here).
 */
export function claudeSandboxStep(box: Pick<OmniRushWorkspaceBox, "on" | "setup"> | null): "on" | OmniRushWorkspaceBoxSetupAction | null {
  if (!box) return null;
  if (!box.on) return "on";
  const need = box.setup?.need;
  if ((need === "linux_allow" || need === "win_install") && !box.setup?.declined) return need;
  return null;
}

/** Set the project's sandbox up for Claude: on, then this computer's setup step (each at most once). */
export async function setUpClaudeSandbox(client: Pick<OmniRushServerClient, "getWorkspaceBox" | "setWorkspaceBox" | "setupWorkspaceBox">, workspaceId: string): Promise<OmniRushWorkspaceBox | null> {
  let box = await client.getWorkspaceBox(workspaceId, { fresh: true }).catch(() => null);
  const done = new Set<string>();
  for (let step = claudeSandboxStep(box); step && !done.has(step); step = claudeSandboxStep(box)) {
    done.add(step);
    box = step === "on" ? await client.setWorkspaceBox(workspaceId, "on") : await client.setupWorkspaceBox(workspaceId, step);
  }
  return box;
}

type StatusClient = { claude: Pick<OmniRushServerClient["claude"], "request"> };

/** The open project's Claude models, read from its server (again when the window comes back). */
export function useClaudeModelSync(client: StatusClient | null, workspaceId: string | null) {
  useEffect(() => {
    if (!client || !workspaceId) {
      useClaudeModels.setState(EMPTY);
      return;
    }
    let closed = false;
    const load = () => {
      void client.claude.request<{ models?: unknown; catalog?: unknown; reason?: unknown }>(workspaceId, "status").then((status) => {
        if (!closed) useClaudeModels.setState(parseClaudeStatus(workspaceId, status));
      }, () => {
        // An older or unreachable server: no Claude entries, nothing breaks.
        if (!closed) useClaudeModels.setState({ ...EMPTY, workspaceId });
      });
    };
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    load();
    document.addEventListener("visibilitychange", onVisible);
    return () => { closed = true; document.removeEventListener("visibilitychange", onVisible); };
  }, [client, workspaceId]);
}

export function parseClaudeStatus(workspaceId: string, status: { models?: unknown; catalog?: unknown; reason?: unknown } | null | undefined): ClaudeModelsState {
  const catalog = Array.isArray(status?.catalog)
    ? status.catalog.flatMap((entry): ClaudeCatalogEntry[] => entry && typeof entry.id === "string" && CLAUDE_ID.test(entry.id)
      ? [{ id: entry.id, name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.id }] : [])
    : [];
  const models = Array.isArray(status?.models) ? status.models.filter((id): id is string => typeof id === "string" && CLAUDE_ID.test(id)) : [];
  return { workspaceId, catalog, models, reason: typeof status?.reason === "string" ? status.reason : null };
}

/**
 * The open route's handler for a model pick (set by the session route): true
 * when it took the pick (a popup, a message, Claude), so the picker does not
 * switch the chat's model itself.
 */
export const useModelPickGate = create<{ intercept: (next: ModelRef, sessionId: string | null) => boolean }>(() => ({ intercept: () => false }));
