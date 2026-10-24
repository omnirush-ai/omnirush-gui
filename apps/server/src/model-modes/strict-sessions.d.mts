// Types of strict-sessions.mjs (the same pair of files in omnirush-cli
// src/model-modes/ and omnirush-gui apps/server/src/model-modes/; PARITY.sha256).

import type { ModelMode } from "./model-modes.mjs";

export const STRICT_BIND_PATH: "/omnirush/device/session-binding";
export const SESSION_BINDING_CONFLICT: "session_binding_conflict";
export const SESSION_UNKNOWN_PARENT: "session_unknown_parent";
export const SESSION_MODEL_USED: "session_model_used";
export const STRICT_SESSION_HEADER: "x-omnirush-strict-session";
export const VERIFICATION_REQUIRED: "verification_required";
export const MODEL_NOT_BOUND: "model_not_bound";
export const MODE_NOT_BOUND: "mode_not_bound";
export const BIND_TIMEOUT_MS: number;
export const VERIFICATION_MESSAGE: string;
export const SESSION_BIND_UNCONFIRMED: "session_bind_unconfirmed";
export const UNCONFIRMED_MESSAGE: string;

export type ChatPin = { model: string; mode: ModelMode; revision?: string | null; capturePolicy?: string | null };
export type BindChat = ChatPin & { path: string | null; enforce?: boolean; sessionId: string; rootId?: string | null; root?: ChatPin | null };
export type BindOutcome = { ok: true; binding?: Record<string, unknown> } | { refused: { code: string; message: string; retry: boolean } };
export type StrictSessions = { mode: "observe" | "enforce"; path: string; header: string };
export type BindPost = (path: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<{ status: number; body: unknown }>;

export function strictSessions(capabilities: unknown): StrictSessions | null;
export function bindingConflictMessage(binding: unknown, model: string): string;
export function modelUsedMessage(modelsUsed: unknown, model: string): string;
export function sessionBinder(post: BindPost, options?: { timeoutMs?: number }): (chat: BindChat) => Promise<BindOutcome>;
