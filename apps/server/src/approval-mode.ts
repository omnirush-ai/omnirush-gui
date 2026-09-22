/**
 * Approval mode of the desktop engine.
 *
 *   guarded  (default) the git workflow rules ask for write and destructive
 *            commands; everything else follows the engine defaults.
 *   full     every engine permission is allowed without a prompt; the
 *            organization's deny rules from Den still apply.
 *
 * Precedence, highest first: OMNIRUSH_APPROVALS=full|guarded in the server
 * (desktop) process environment, then the user setting persisted in the
 * global runtime config row, then guarded. The server resolves the mode; the
 * managed-policy engine plugin learns it from every /managed-policy/evaluate
 * answer, so a toggle applies to the next tool call without an engine restart
 * (the injected permission rules still need the reload Settings triggers).
 *
 * Shared by the server and the engine plugins (imported with "../"), so it
 * must stay free of server-only dependencies.
 */
export type ApprovalMode = "guarded" | "full";
export type ApprovalModeSource = "environment" | "settings" | "default";

export const APPROVAL_MODE_ENV = "OMNIRUSH_APPROVALS";
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "guarded";

export interface ResolvedApprovalMode {
  mode: ApprovalMode;
  source: ApprovalModeSource;
  /** The persisted user setting, whether or not the environment overrides it. */
  setting: ApprovalMode | null;
}

export function parseApprovalMode(value: unknown): ApprovalMode | null {
  if (typeof value !== "string") return null;
  const mode = value.trim().toLowerCase();
  return mode === "full" || mode === "guarded" ? mode : null;
}

export function approvalModeFromEnv(env: NodeJS.ProcessEnv = process.env): ApprovalMode | null {
  return parseApprovalMode(env[APPROVAL_MODE_ENV]);
}

export function resolveApprovalMode(
  runtime: { approvals?: { mode: ApprovalMode } },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedApprovalMode {
  const setting = runtime.approvals?.mode ?? null;
  const environment = approvalModeFromEnv(env);
  if (environment) return { mode: environment, source: "environment", setting };
  if (setting) return { mode: setting, source: "settings", setting };
  return { mode: DEFAULT_APPROVAL_MODE, source: "default", setting };
}
