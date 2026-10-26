/**
 * The model provider lock as the app's server reports it
 * (GET /omnirush/provider-lock; apps/server/src/provider-lock.ts). While
 * locked, only the allowed providers (OmniRush's own) show in model pickers,
 * and the screens that add a provider, store its key or sign in to it are
 * hidden or show the server's message. The server and the engine enforce the
 * lock; this only keeps the UI from offering what they refuse.
 *
 * Locked until the server answers otherwise: no answer, an error or an older
 * server keeps it locked.
 */
import { useSyncExternalStore } from "react";

export const PROVIDER_LOCK_DEFAULT_MESSAGE = "Only OmniRush models are available.";
/** User plugins while locked: the engine loads only the app's own plugins (owner decision). */
export const PLUGINS_LOCKED_MESSAGE = "Custom plugins are off while OmniRush models are locked.";

export type ProviderLockState = {
  locked: boolean;
  allow: string[];
  message: string;
};

const LOCKED: ProviderLockState = Object.freeze({
  locked: true,
  allow: Object.freeze(["omnirush", "omnirush-claude"]) as unknown as string[],
  message: PROVIDER_LOCK_DEFAULT_MESSAGE,
});

let state: ProviderLockState = LOCKED;
const listeners = new Set<() => void>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The state of a server answer; anything but a well-formed `locked: false` is locked. */
export function parseProviderLockState(value: unknown): ProviderLockState {
  if (!isRecord(value)) return LOCKED;
  const message = typeof value.message === "string" && value.message.trim() ? value.message.trim() : PROVIDER_LOCK_DEFAULT_MESSAGE;
  if (value.locked === false) return { locked: false, allow: [], message };
  // Only OmniRush's own providers (the gateway's, Claude Code in the sandbox) count as allowed, whatever else a server lists.
  return { locked: true, allow: ["omnirush", "omnirush-claude"], message };
}

export function providerLockState(): ProviderLockState {
  return state;
}

/** Whether the app's server has answered at least once (until then the start state, locked, is assumed). */
let answered = false;

export function providerLockAnswered(): boolean {
  return answered;
}

/** Sets the state from a server answer (null: no answer, locked). */
export function setProviderLockState(value: unknown): void {
  const next = parseProviderLockState(value);
  const nowAnswered = answered || isRecord(value);
  if (
    nowAnswered === answered
    && next.locked === state.locked && next.message === state.message && next.allow.join(",") === state.allow.join(",")
  ) return;
  answered = nowAnswered;
  // A new object, so subscribers re-render when only `answered` changed.
  state = { ...next };
  for (const listener of listeners) listener();
}

/** Back to the start state: locked, not answered (tests). */
export function resetProviderLockState(): void {
  answered = false;
  state = LOCKED;
  for (const listener of listeners) listener();
}

export function subscribeProviderLock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isProviderLocked(): boolean {
  return state.locked;
}

/** Whether a provider may be used under the lock (always, when unlocked). */
export function isProviderAllowedByLock(providerID: string | null | undefined, current: ProviderLockState = state): boolean {
  if (!current.locked) return true;
  const id = providerID?.trim().toLowerCase() ?? "";
  return id.length > 0 && current.allow.includes(id);
}

export function providerLockMessage(): string {
  return state.message;
}

/** The lock state for a component; it re-renders when the server's answer changes. */
export function useProviderLock(): ProviderLockState {
  return useSyncExternalStore(subscribeProviderLock, providerLockState, providerLockState);
}
