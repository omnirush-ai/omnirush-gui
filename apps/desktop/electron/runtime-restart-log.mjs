import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Restart record and restart policy for the built-in server and its engine.
 *
 * Every stop of a running server ends every live run, so each one is written
 * with its reason and trigger to omnirush-server.log and to a small JSON-lines
 * history next to it (runtime-restarts.jsonl, also appended by the server for
 * engine recoveries it performs itself). omnirushServerInfo returns the tail
 * of that history for the diagnostics bundle.
 */

export const RUNTIME_RESTART_LOG_FILE_NAME = "runtime-restarts.jsonl";
const MAX_HISTORY_BYTES = 256 * 1024;
const KEEP_AFTER_TRIM = 100;
/** A deferred restart whose busy check stays unreadable this long runs anyway: the engine is gone. */
export const DEFERRED_RESTART_UNKNOWN_MAX_MS = 10 * 60_000;

export function runtimeRestartLogPath(serverLogFile) {
  return path.join(path.dirname(serverLogFile), RUNTIME_RESTART_LOG_FILE_NAME);
}

function trimHistory(historyFile) {
  try {
    if (statSync(historyFile).size <= MAX_HISTORY_BYTES) return;
    const lines = readFileSync(historyFile, "utf8").split("\n").filter(Boolean);
    writeFileSync(historyFile, `${lines.slice(-KEEP_AFTER_TRIM).join("\n")}\n`, "utf8");
  } catch {
    // Diagnostics only.
  }
}

/**
 * Append one record to the history and one structured line to the server log.
 * Best effort: diagnostics must never block or fail a restart.
 *
 * @param {{ serverLogFile: string | null, record: Record<string, unknown> & { kind: string, action: string,
 *   reason: string, source: string }, now?: () => Date }} input
 */
export function appendRuntimeRestartRecord({ serverLogFile, record, now = () => new Date() }) {
  if (!serverLogFile) return null;
  const at = now();
  const entry = { at: at.toISOString(), ...record };
  const historyFile = runtimeRestartLogPath(serverLogFile);
  try {
    mkdirSync(path.dirname(historyFile), { recursive: true });
    appendFileSync(historyFile, `${JSON.stringify(entry)}\n`, "utf8");
    trimHistory(historyFile);
  } catch {
    // Diagnostics only.
  }
  const attributes = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) attributes[`runtime.restart.${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`] = value;
  }
  const line = {
    timeUnixNano: `${BigInt(at.getTime()) * 1_000_000n}`,
    severityText: record.action === "deferred" || record.action === "skipped" ? "INFO" : "WARN",
    body: `Built-in ${record.kind === "engine" ? "engine" : "server"} ${record.action}: ${record.reason} (${record.source})`,
    attributes,
    resource: { "service.name": "omnirush-desktop-runtime" },
  };
  try {
    mkdirSync(path.dirname(serverLogFile), { recursive: true });
    appendFileSync(serverLogFile, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // Diagnostics only.
  }
  return entry;
}

/** Newest first. Unreadable or partial lines are skipped. */
export async function readRuntimeRestartRecords(serverLogFile, limit = 20) {
  if (!serverLogFile) return [];
  let text = "";
  try {
    text = await readFile(runtimeRestartLogPath(serverLogFile), "utf8");
  } catch {
    return [];
  }
  const records = [];
  const lines = text.split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0 && records.length < limit; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === "object" && typeof value.at === "string") records.push(value);
    } catch {
      // Skip a torn line.
    }
  }
  return records;
}

/**
 * Whether a lifecycle request may stop the running server now.
 *
 *   action: "engine-restart" | "server-restart" | "engine-start"
 *   busy:   { sessions: number, unknown: number } — unknown probes count as busy
 *
 * Returns { verdict: "proceed" | "defer" | "skip", why }.
 *
 * @param {{ action: string, userInitiated?: boolean, serverRunning: boolean, serverHealthy: boolean,
 *   busy?: { sessions: number, unknown: number }, sameSettings?: boolean }} input
 * @returns {{ verdict: "proceed" | "defer" | "skip", why: string }}
 */
export function decideRuntimeRestart({ action, userInitiated, serverRunning, serverHealthy, busy, sameSettings }) {
  if (!serverRunning) return { verdict: "proceed", why: "server_not_running" };
  if (userInitiated === true) return { verdict: "proceed", why: "user_initiated" };
  if (!serverHealthy) return { verdict: "proceed", why: "server_unresponsive" };
  // A healthy server already runs with what was asked for: a restart would
  // only kill live runs. This covers renderer health checks that timed out
  // while the server was merely busy, and renderer reloads re-running boot.
  if (action === "engine-start") return { verdict: "skip", why: "server_healthy" };
  if (action === "server-restart" && sameSettings === true) return { verdict: "skip", why: "server_healthy" };
  if ((busy?.sessions ?? 0) > 0 || (busy?.unknown ?? 0) > 0) return { verdict: "defer", why: "sessions_busy" };
  return { verdict: "proceed", why: "idle" };
}

/**
 * Whether a deferred restart runs now: "run", "wait" or "drop" (the server
 * it was meant for is gone; whoever starts the next one applies everything).
 *
 * @param {{ serverRunning: boolean, serverHealthy: boolean,
 *   busy?: { sessions: number, unknown: number }, deferredForMs: number }} input
 * @returns {"run" | "wait" | "drop"}
 */
export function decideDeferredRestart({ serverRunning, serverHealthy, busy, deferredForMs }) {
  if (!serverRunning) return "drop";
  if (!serverHealthy) return "run";
  if ((busy?.sessions ?? 0) > 0) return "wait";
  if ((busy?.unknown ?? 0) > 0 && deferredForMs < DEFERRED_RESTART_UNKNOWN_MAX_MS) return "wait";
  return "run";
}
