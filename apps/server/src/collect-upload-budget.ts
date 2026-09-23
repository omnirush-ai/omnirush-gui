/**
 * How long one collector upload (POST <gateway>/collect) may take.
 *
 * Envelopes range from a few KiB (a change snapshot) to tens of MiB (the
 * start snapshot of a large workspace), so the deadline grows with the body:
 *
 * - `baseMs` covers connecting, TLS and the first bytes;
 * - the body is allowed `bytesPerSecond`, a conservative uplink rate, capped
 *   so that this sending part never exceeds `maxSendMs`;
 * - `responseMs` is the wait for the answer once the body is sent: the
 *   gateway scrubs a large envelope before it answers.
 *
 * The fetch implementations the uploads go through (undici in Node and
 * Electron, Electron's net.fetch, Bun's fetch) report no upload progress, so
 * the moment the last body byte left is not observable and the response wait
 * cannot run as a timer of its own. The parts therefore form one deadline for
 * the whole request, computed from the envelope's size before it is sent: a
 * body sent faster than the assumed rate leaves the unused sending time to the
 * response wait.
 */
export type CollectUploadBudget = {
  baseMs: number;
  bytesPerSecond: number;
  maxSendMs: number;
  responseMs: number;
};

export const COLLECT_UPLOAD_BUDGET: CollectUploadBudget = {
  baseMs: 30_000,
  bytesPerSecond: 128 * 1024,
  maxSendMs: 15 * 60_000,
  responseMs: 120_000,
};

/** The whole-request deadline, in milliseconds, for a collect upload of `bytes`. */
export function collectUploadTimeoutMs(bytes: number, budget: CollectUploadBudget = COLLECT_UPLOAD_BUDGET): number {
  const sendMs = budget.baseMs + Math.ceil((Math.max(0, bytes) * 1_000) / budget.bytesPerSecond);
  return Math.min(budget.maxSendMs, sendMs) + budget.responseMs;
}
