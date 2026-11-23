// Work chat sync from the Mac (iMessage and the WhatsApp Mac apps) and from
// Telegram (any desktop): reads the local databases (work-imessage.mjs,
// work-whatsapp.mjs) or the user's own Telegram login (work-telegram.mjs) and
// pushes the chat-days through the local server (/work/imessage,
// /work/whatsapp-local, /work/telegram),
// at app start, every 10 minutes and soon after a database's write-ahead log
// changes, while its "Data sync" switch is on. The switch turns itself on
// after the first good read (Sync now). One read at a time; errors back off.
// A source the company turned off (refused with connector_off) is not read
// again until the Work state's sources list it again.
// The read position and switch live here (<userData>/work-chat-sync.json),
// per server and Work account, so an account switch never mixes data.
// Pushes are small (100 chat-days or 1.5 MB), and a reader that can say so
// (`cursorAt`) has its read position saved after each one, so a failed push
// never sends again what already landed and a long first sync carries on
// over several runs. The card polls `status()` for the run's progress.

import { watch as fsWatch } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const CHAT_SYNC_FILE = "work-chat-sync.json";
export const SYNC_EVERY_MS = 10 * 60_000;
export const START_DELAY_MS = 30_000;
// A busy chat writes the log every few seconds: wait for a quiet minute,
// and never read again within two minutes of the last read.
export const WATCH_QUIET_MS = 60_000;
export const MIN_GAP_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
// The server takes at most 2,000 records and 20 MB per push, and stores a push in one request: 1,000 chat-days
// once took 131 s. Small pushes finish well inside the timeout and each one saves the read position.
const BATCH_RECORDS = 100;
const BATCH_BYTES = 1_500_000;
export const PUSH_TIMEOUT_MS = 300_000;
// The local server's own answers (the Work account) are quick.
const STATE_TIMEOUT_MS = 30_000;
// A push that timed out, could not reach the local server or got a 5xx or 429 is sent once more after this.
export const RETRY_DELAY_MS = 3_000;

/** Records in slices under the push limits (bytes of JSON); a chat-day is never split. */
export function batches(records, maxRecords = BATCH_RECORDS, maxBytes = BATCH_BYTES) {
  const out = [];
  let batch = [];
  let bytes = 0;
  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(record));
    if (batch.length && (batch.length >= maxRecords || bytes + size > maxBytes)) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(record);
    bytes += size;
  }
  if (batch.length) out.push(batch);
  return out;
}

/** The wait after `failures` failed reads in a row: 10 min doubling, at most 6 h. */
export function backoffMs(failures) {
  return Math.min(SYNC_EVERY_MS * 2 ** Math.min(Math.max(failures - 1, 0), 10), MAX_BACKOFF_MS);
}

/** A server with company connector lists refuses a source the company (or OmniRush) turned off with these. */
const TURNED_OFF = new Set(["connector_off", "connector_not_allowed"]);

/** `retry`: worth one more try (a timeout, the local server not reached, a 5xx or 429). */
class SyncError extends Error {
  constructor(code, retry = false) {
    super(code);
    this.code = code;
    this.retry = retry;
  }
}

/**
 * @param {{
 *   sources: Record<string, { read: (cursor: any, account: string) => Promise<{ records: object[], cursor: any, messageCount: number, retryAfterMs?: number, cursorAt?: (sent: number) => any }>, route: string, watch?: { dir: string, file: string }[] }>,
 *   localServer: () => Promise<{ baseUrl: string | null, token: string | null } | null>,
 *   file: string,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout,
 *   setRepeat?: typeof setInterval, clearRepeat?: typeof clearInterval,
 *   sleep?: (ms: number) => Promise<void>,
 *   watch?: (dir: string, listener: (event: string, name: string | null) => void) => { close: () => void, on?: (event: "error", fn: () => void) => unknown },
 *   log?: (line: string) => void,
 * }} deps
 */
export function createChatSync(deps) {
  const {
    sources, localServer, file,
    // loopback-fetch: the pushes go to the locally managed OmniRush.ai server.
    fetchImpl = fetch,
    now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    watch = (dir, listener) => fsWatch(dir, { persistent: false }, listener),
    log = (line) => console.info(line),
  } = deps;
  /** @type {Map<string, Promise<any>>} */
  const pending = new Map();
  let chain = Promise.resolve();
  let running = null;
  /** The running read's progress for the card: reading, then uploading with pushes and chat-days sent and in all. */
  let progress = null;
  let lastRunAt = 0;
  let repeat = null;
  const timers = new Map();
  const watchers = new Map();
  let stopped = false;
  let writes = Promise.resolve();

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8"));
      return parsed && typeof parsed === "object" && parsed.accounts && typeof parsed.accounts === "object" ? parsed : { accounts: {} };
    } catch {
      return { accounts: {} };
    }
  }

  /** Changes one source's saved entry; `change` gets the latest, so a switch flipped during a read is kept. Writes go one at a time. */
  function update(account, source, change) {
    const next = writes.then(async () => {
      const data = await load();
      const entry = change(data.accounts[account]?.[source] ?? {});
      data.accounts[account] = { ...(data.accounts[account] ?? {}), [source]: entry };
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
      await rename(temp, file);
      return entry;
    });
    writes = next.catch(() => undefined);
    return next;
  }

  async function call(server, route, init = {}, timeoutMs = STATE_TIMEOUT_MS) {
    let response;
    try {
      response = await fetchImpl(`${server.baseUrl}${route}`, {
        ...init,
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SyncError(error?.name === "TimeoutError" ? "timeout" : "unreachable", true);
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new SyncError(typeof body?.code === "string" ? body.code : `http_${response.status}`, response.status >= 500 || response.status === 429);
    return body;
  }

  /** The local server, the Work account it speaks for and the account's sources; null while signed out, offline or Work is off. */
  async function who() {
    const server = await localServer().catch(() => null);
    if (!server?.baseUrl || !server.token) return null;
    const state = await call(server, "/work/state?account=1").catch(() => null);
    if (!state?.enabled || typeof state.account !== "string" || !state.account) return null;
    return { server, account: state.account, sources: Array.isArray(state.sources) ? state.sources : null };
  }

  const floodWaiting = (entry) => entry.lastError === "flood_wait" && Boolean(entry.nextAt) && now() < entry.nextAt;

  async function runOnce(source, manual) {
    const spec = sources[source];
    const me = await who();
    if (!me) return { status: "skipped", reason: "work_off" };
    const entry = (await load()).accounts[me.account]?.[source] ?? {};
    // Telegram's FLOOD_WAIT holds for Sync now and the switch too: no request before the time it asked for.
    if (floodWaiting(entry)) return { status: "skipped", reason: "flood_wait" };
    if (!manual && (entry.enabled !== true || (entry.nextAt && now() < entry.nextAt))) return { status: "skipped", reason: "off" };
    // Refused as turned off by the company: nothing is read until the account's sources list it again.
    if (!manual && TURNED_OFF.has(entry.lastError) && me.sources && !me.sources.includes(source)) return { status: "skipped", reason: "turned_off" };
    lastRunAt = now();
    running = source;
    progress = { phase: "reading", pushesDone: 0, pushesTotal: 0, recordsDone: 0, recordsTotal: 0 };
    try {
      const read = await spec.read(entry.cursor, me.account);
      // The server restarts on an account switch with the same port and token: the account is checked before every
      // push (a retry too), so no batch lands in another account, and once more after the last; on a change the read
      // position stays where the last checked push left it.
      const switched = async () => (await who())?.account !== me.account;
      const changed = { status: "skipped", reason: "account_changed" };
      /** One push, and once more after a short wait when that is worth it; false: the account changed meanwhile. */
      const send = async (batch) => {
        const init = { method: "POST", body: JSON.stringify({ records: batch }) };
        try {
          await call(me.server, spec.route, init, PUSH_TIMEOUT_MS);
        } catch (error) {
          if (!(error instanceof SyncError) || !error.retry) throw error;
          log(`[work-chat-sync] ${source} push failed: ${error.code}, trying once more`);
          await sleep(RETRY_DELAY_MS);
          if (await switched()) return false;
          await call(me.server, spec.route, init, PUSH_TIMEOUT_MS);
        }
        return true;
      };
      const pushes = batches(read.records);
      progress = { phase: "uploading", pushesDone: 0, pushesTotal: pushes.length, recordsDone: 0, recordsTotal: read.records.length };
      if (await switched()) return changed;
      let sent = 0;
      for (const [index, batch] of pushes.entries()) {
        if (!(await send(batch))) return changed;
        sent += batch.length;
        progress = { ...progress, pushesDone: index + 1, recordsDone: sent };
        if (await switched()) return changed;
        // What landed is kept: the read position moves past it, and the switch turns on as after a good read.
        if (read.cursorAt && index < pushes.length - 1) {
          const cursor = read.cursorAt(sent);
          await update(me.account, source, (latest) => ({ ...latest, enabled: latest.enabled ?? true, cursor, lastError: null, failures: 0, nextAt: null }));
        }
      }
      // A read Telegram slowed down (FLOOD_WAIT) saves what it got and waits its time.
      const wait = Number(read.retryAfterMs) || 0;
      const saved = await update(me.account, source, (latest) => ({ enabled: latest.enabled ?? true, cursor: read.cursor, lastSyncAt: new Date(now()).toISOString(), lastError: wait ? "flood_wait" : null, failures: 0, nextAt: wait ? now() + wait : null }));
      if (saved.enabled) ensureWatch(source);
      return { status: "ok", messages: read.messageCount, records: read.records.length };
    } catch (error) {
      const code = typeof error?.code === "string" && /^[a-z0-9_]{1,40}$/.test(error.code) ? error.code : "sync_failed";
      log(`[work-chat-sync] ${source} failed: ${code}`);
      await update(me.account, source, (latest) => {
        const failures = (latest.failures ?? 0) + 1;
        return { ...latest, lastError: code, failures, nextAt: now() + backoffMs(failures) };
      }).catch(() => undefined);
      return { status: "error", code };
    } finally {
      running = null;
      progress = null;
    }
  }

  /** One read at a time across sources; a source already waiting or running shares that run. */
  function run(source, { manual = false } = {}) {
    if (!sources[source]) return Promise.resolve({ status: "skipped", reason: "unknown" });
    const key = `${source}:${manual}`;
    const queued = pending.get(key);
    if (queued) return queued;
    const next = chain.then(() => runOnce(source, manual)).finally(() => pending.delete(key));
    pending.set(key, next);
    chain = next.catch(() => undefined);
    return next;
  }

  function tick() {
    if (stopped) return Promise.resolve([]);
    return Promise.all(Object.keys(sources).map((source) => run(source)));
  }

  /** The first read once the local server is up (it starts after the window): tried each minute, five times. */
  function startTick(tries = 5) {
    void tick().then((results) => {
      if (tries > 1 && results.length && results.every((result) => result.reason === "work_off")) {
        timers.set("start", setTimer(() => startTick(tries - 1), 60_000));
      }
    });
  }

  /** A quiet minute after the last log change, and at least MIN_GAP_MS after the last read. */
  function soon(source) {
    if (stopped) return;
    clearTimer(timers.get(source));
    const wait = Math.max(WATCH_QUIET_MS, lastRunAt + MIN_GAP_MS - now());
    timers.set(source, setTimer(() => void run(source), wait));
  }

  /** Watch each database's folder for log writes (after a good read with the switch on); without Full Disk Access it cannot, and tries after the next. */
  function ensureWatch(source) {
    for (const { dir, file: name } of sources[source].watch ?? []) {
      if (stopped || watchers.has(dir)) continue;
      try {
        const handle = watch(dir, (_event, changed) => {
          if (!changed || String(changed) === name) soon(source);
        });
        handle.on?.("error", () => {
          handle.close();
          watchers.delete(dir);
        });
        watchers.set(dir, handle);
      } catch {
        // EPERM without Full Disk Access, or the app is not installed.
      }
    }
  }

  return {
    run,
    /** The Work account the local server speaks for (null: signed out, offline or Work off). */
    account: async () => (await who())?.account ?? null,
    start() {
      stopped = false;
      timers.set("start", setTimer(() => startTick(), START_DELAY_MS));
      repeat = setRepeat(() => void tick(), SYNC_EVERY_MS);
      // No folder is watched yet: a source's is, once it is on and read (runOnce), so nothing is opened without opting in.
    },
    stop() {
      stopped = true;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      if (repeat) clearRepeat(repeat);
      repeat = null;
      for (const handle of watchers.values()) handle.close();
      watchers.clear();
    },
    /**
     * Each source's switch, last sync and error for the current account (null: signed out or Work off).
     * @returns {Promise<import("@omnirush/types/desktop-ipc").WorkChatSyncStatus>}
     */
    async status() {
      const me = await who();
      if (!me) return null;
      const saved = (await load()).accounts[me.account] ?? {};
      return /** @type {any} */ (Object.fromEntries(Object.keys(sources).map((source) => {
        const entry = saved[source] ?? {};
        const mine = running === source;
        return [source, { enabled: entry.enabled ?? null, lastSyncAt: entry.lastSyncAt ?? null, lastError: entry.lastError ?? null, failures: entry.failures ?? 0, running: mine, progress: mine && progress ? { ...progress } : null }];
      })));
    },
    /** The switch; turning it on reads now. */
    async setEnabled(source, enabled) {
      const me = await who();
      if (!me || !sources[source]) return null;
      await update(me.account, source, (entry) => ({ ...entry, enabled: enabled === true, nextAt: floodWaiting(entry) ? entry.nextAt : null }));
      return enabled === true ? run(source, { manual: true }) : { status: "skipped", reason: "off" };
    },
  };
}
