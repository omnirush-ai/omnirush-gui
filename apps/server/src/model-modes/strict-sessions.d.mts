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

export type ChatPin = { model: string; mode: ModelMode; revision?: string | null };
export type BindChat = ChatPin & { path: string | null; sessionId: string; rootId?: string | null; capturePolicy?: string | null; root?: ChatPin | null };
export type BindOutcome = { ok: true } | { refused: { code: string; message: string } };
export type BindPost = (path: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<{ status: number; body: unknown }>;

export function strictSessions(capabilities: unknown): { path: string; header: string } | null;
export function bindingConflictMessage(binding: unknown, model: string): string;
export function modelUsedMessage(modelsUsed: unknown, model: string): string;
export function sessionBinder(post: BindPost, options?: { timeoutMs?: number }): (chat: BindChat) => Promise<BindOutcome>;
