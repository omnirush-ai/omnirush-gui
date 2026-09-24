import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { SERVER_LOG_FILE_ENV } from "./server-log-file.js";

/**
 * Persisted record of every built-in server and managed engine restart.
 *
 * The desktop runtime (apps/desktop/electron/runtime-restart-log.mjs) writes
 * server restarts to the same JSON-lines file next to omnirush-server.log;
 * the server adds the engine recoveries it performs on its own. The desktop
 * reads the tail back into omnirushServerInfo for the diagnostics bundle.
 */
export const RUNTIME_RESTART_LOG_FILE_NAME = "runtime-restarts.jsonl";

export type RuntimeRestartRecord = {
  at: string;
  kind: "server" | "engine";
  action: string;
  reason: string;
  source: string;
  busySessions?: number | null;
  detail?: string | null;
};

export function runtimeRestartLogPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const logFile = env[SERVER_LOG_FILE_ENV]?.trim();
  return logFile ? join(dirname(logFile), RUNTIME_RESTART_LOG_FILE_NAME) : null;
}

/** Best effort: a record that cannot be written never blocks a recovery. */
export function appendRuntimeRestartRecord(
  record: Omit<RuntimeRestartRecord, "at"> & { at?: string },
  path: string | null = runtimeRestartLogPath(),
): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ...record, at: record.at ?? new Date().toISOString() })}\n`, "utf8");
  } catch {
    // Diagnostics only.
  }
}
