/**
 * Damaged records in the engine's session store, set aside before the engine
 * starts (the desktop's port of the CLI's src/engine-store-repair.js).
 *
 * The engine keeps every session in one SQLite file
 * (`<engine data>/omnirush/opencode.db`, engine-data-home.ts) and stores parts
 * of each row as JSON text (session.model, session.permission, message.data,
 * part.data, ...). It reads those columns into fixed shapes while it reads the
 * rows, so ONE value that does not parse, or parses to the wrong shape, fails
 * the whole request with a 500 "Unexpected server error":
 *
 *   - session.permission not a list of rules: "Spread syntax requires
 *     ...iterable" on `GET /session/:id` and on the project's session list;
 *   - session.model without a string id and providerID, session.revert
 *     without a string messageID: "Expected string, got undefined";
 *   - any JSON column cut short (a write interrupted by sleep, a killed app):
 *     "JSON Parse error".
 *
 * One such row makes its chat fail to open and the project's whole session
 * list fail to load. repairEngineStore runs before the engine starts
 * (managed-opencode.ts) and never throws. It finds the damaged values, takes a
 * copy of the store first (<db>.bak-<time>), saves each damaged row as it was
 * to <db>.corrupt-<time>.jsonl next to the store, and then:
 *   - session / project: the damaged optional column is cleared (or reset to
 *     its empty value); the session and all its messages stay, the engine
 *     fills the column again;
 *   - message: a row whose data does not parse is moved out with its parts
 *     (they cannot be read); the chat itself stays;
 *   - part: a row whose data does not parse is moved out.
 * Every other row stays exactly as it was. Session and project rows are
 * checked at every start (the tables are small); message and part rows in
 * full once, then from where the previous check ended (with an overlap).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { engineDataDir } from "./engine-data-home.js";

type Row = Record<string, unknown>;
type Store = {
  exec: (sql: string) => void;
  all: (sql: string, ...params: unknown[]) => Row[];
  get: (sql: string, ...params: unknown[]) => Row | undefined;
  run: (sql: string, ...params: unknown[]) => void;
  close: () => void;
};
export type EngineStoreRepairLog = (level: "info" | "warn", message: string, attributes?: Record<string, unknown>) => void;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown) => typeof value === "string";
const optionalText = (value: unknown) => value === undefined || value === null || typeof value === "string";

type ColumnRule = { column: string; fallback?: string; valid: (value: unknown) => boolean };

/** Optional JSON columns and the shape the engine reads them into; a damaged value is cleared (or set to `fallback`). */
const ROW_COLUMNS: Record<string, ColumnRule[]> = {
  session: [
    { column: "summary_diffs", valid: (value) => Array.isArray(value) },
    { column: "metadata", valid: isObject },
    {
      column: "revert",
      valid: (value) => isObject(value) && isText(value.messageID) && optionalText(value.partID) && optionalText(value.snapshot) && optionalText(value.diff),
    },
    {
      column: "permission",
      valid: (value) => Array.isArray(value) && value.every((rule) => isObject(rule) && isText(rule.permission) && isText(rule.pattern) && isText(rule.action)),
    },
    { column: "model", valid: (value) => isObject(value) && isText(value.id) && isText(value.providerID) && optionalText(value.variant) },
  ],
  project: [
    { column: "sandboxes", fallback: "[]", valid: (value) => Array.isArray(value) },
    { column: "commands", valid: (value) => value === null || typeof value === "object" },
  ],
};
/** Tables whose JSON `data` column is the row itself: a row that does not parse is moved out. */
const DATA_TABLES = ["message", "part"] as const;
/** Rows re-checked below the previous high-water mark (parts are updated in place while they stream). */
const RECHECK_ROWS = 5_000;
const MARKER = "engine-store-check.json";

/** The engine's session store: OPENCODE_DB when set, else `<engine data>/omnirush/opencode.db`. Null for an in-memory store. */
export function engineStorePath(env: NodeJS.ProcessEnv): string | null {
  const asked = String(env.OPENCODE_DB ?? "").trim();
  if (asked === ":memory:") return null;
  const dataDir = engineDataDir(env);
  if (asked) return isAbsolute(asked) ? asked : join(dataDir, asked);
  return join(dataDir, "opencode.db");
}

async function openStore(file: string): Promise<Store> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(file, { create: false, readwrite: true });
    return {
      exec: (sql) => db.exec(sql),
      all: (sql, ...params) => db.query(sql).all(...(params as never[])) as Row[],
      get: (sql, ...params) => (db.query(sql).get(...(params as never[])) ?? undefined) as Row | undefined,
      run: (sql, ...params) => void db.query(sql).run(...(params as never[])),
      close: () => db.close(),
    };
  }
  // A literal specifier would make Bun's bundler try to resolve node:sqlite.
  const specifier = "node:sqlite";
  const { DatabaseSync } = (await import(specifier)) as typeof import("node:sqlite");
  const db = new DatabaseSync(file);
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, ...params) => db.prepare(sql).all(...(params as never[])) as Row[],
    get: (sql, ...params) => db.prepare(sql).get(...(params as never[])) as Row | undefined,
    run: (sql, ...params) => void db.prepare(sql).run(...(params as never[])),
    close: () => db.close(),
  };
}

function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return String(value);
}

/** The parsed value, or `damaged` when it does not parse. */
const DAMAGED = Symbol("damaged");
function parsed(value: unknown): unknown {
  const text = textOf(value);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return DAMAGED;
  }
}

function tableColumns(db: Store, table: string): Set<string> {
  try {
    return new Set(db.all(`PRAGMA table_info("${table}")`).map((row) => String(row.name)));
  } catch {
    return new Set();
  }
}

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

function readMarker(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

function plain(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : typeof value === "bigint" ? Number(value) : value,
  ]));
}

export type EngineStoreRepair = { table: string; id: string | null; column?: string; action: "cleared" | "reset" | "removed"; parts?: number };
export type EngineStoreRepairResult = {
  checked: boolean;
  repaired: EngineStoreRepair[];
  saved: string | null;
  backup: string | null;
  error?: string;
};

export type EngineStoreRepairOptions = {
  /** The store (default: engineStorePath(env)). */
  file?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Where the check marker lives (default: next to the store). */
  stateDir?: string | null;
  /** Check every message and part row. */
  full?: boolean;
  now?: () => number;
  log?: EngineStoreRepairLog;
};

/**
 * Checks the engine's session store and sets damaged records aside (see the
 * module comment). Never throws.
 */
export async function repairEngineStore(options: EngineStoreRepairOptions = {}): Promise<EngineStoreRepairResult> {
  const env = options.env ?? process.env;
  const file = options.file === undefined ? engineStorePath(env) : options.file;
  const now = options.now ?? Date.now;
  const log: EngineStoreRepairLog = (level, message, attributes) => {
    try {
      options.log?.(level, message, attributes);
    } catch {
      // a log that fails stops nothing
    }
  };
  const result: EngineStoreRepairResult = { checked: false, repaired: [], saved: null, backup: null };
  if (!file || !existsSync(file)) return result;
  let db: Store | null = null;
  try {
    db = await openStore(file);
    try {
      db.exec("PRAGMA busy_timeout = 3000");
    } catch {
      // older binding
    }
    // Throws for a file that is not a database at all (left to the engine to report).
    db.get("SELECT count(*) AS n FROM sqlite_master");
    const markerFile = join(options.stateDir || dirname(file), MARKER);
    const marker = options.full ? {} : readMarker(markerFile);
    const sameStore = marker.file === file;
    type Damaged = { table: string; row: Row; column?: string; fallback?: string };
    const damaged: Damaged[] = [];
    const highWater: Record<string, number> = {};

    for (const [table, rules] of Object.entries(ROW_COLUMNS)) {
      const present = tableColumns(db, table);
      for (const { column, fallback, valid } of rules) {
        if (!present.has(column)) continue;
        // Small tables: every non-null value is read and checked the way the engine reads it.
        for (const row of db.all(`SELECT rowid AS rid, * FROM "${table}" WHERE "${column}" IS NOT NULL`)) {
          const value = parsed(row[column]);
          if (value === null || (value !== DAMAGED && valid(value))) continue;
          damaged.push({ table, column, fallback, row });
        }
      }
    }
    for (const table of DATA_TABLES) {
      const present = tableColumns(db, table);
      if (!present.has("data")) continue;
      const max = Number(db.get(`SELECT MAX(rowid) AS m FROM "${table}"`)?.m ?? 0);
      highWater[table] = max;
      const previousValue = Number(marker[table]);
      const previous = sameStore && Number.isSafeInteger(previousValue) ? previousValue : 0;
      const from = previous > max ? 0 : Math.max(0, previous - RECHECK_ROWS);
      let rows: Row[];
      try {
        rows = db.all(`SELECT rowid AS rid, * FROM "${table}" WHERE rowid > ? AND json_valid(data) = 0`, from);
      } catch {
        rows = db.all(`SELECT rowid AS rid, * FROM "${table}" WHERE rowid > ?`, from);
      }
      for (const row of rows) {
        const value = parsed(row.data);
        if (value !== DAMAGED && isObject(value)) continue;
        damaged.push({ table, row });
      }
    }
    result.checked = true;

    if (damaged.length) {
      const at = stamp(now());
      // A copy of the store as it was, before anything changes.
      const backup = `${file}.bak-${at}`;
      try {
        db.run("VACUUM INTO ?", backup);
        result.backup = backup;
      } catch (error) {
        log("warn", "engine store: no backup copy", { error: error instanceof Error ? error.message : String(error) });
      }
      const saved = `${file}.corrupt-${at}.jsonl`;
      const lines: unknown[] = [];
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const item of damaged) {
          const { table, row } = item;
          if (item.column) {
            db.run(`UPDATE "${table}" SET "${item.column}" = ? WHERE rowid = ?`, item.fallback ?? null, row.rid);
            lines.push({ table, column: item.column, row: plain(row) });
            result.repaired.push({ table, id: textOf(row.id), column: item.column, action: item.fallback ? "reset" : "cleared" });
          } else if (table === "message") {
            const parts = db.all("SELECT rowid AS rid, * FROM part WHERE message_id = ?", row.id);
            for (const part of parts) lines.push({ table: "part", row: plain(part) });
            db.run("DELETE FROM part WHERE message_id = ?", row.id);
            db.run("DELETE FROM message WHERE rowid = ?", row.rid);
            lines.push({ table, row: plain(row) });
            result.repaired.push({ table, id: textOf(row.id), action: "removed", parts: parts.length });
          } else {
            db.run(`DELETE FROM "${table}" WHERE rowid = ?`, row.rid);
            lines.push({ table, row: plain(row) });
            result.repaired.push({ table, id: textOf(row.id), action: "removed" });
          }
        }
        writeFileSync(saved, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, { mode: 0o600, flag: "wx" });
        db.exec("COMMIT");
        result.saved = saved;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // not in a transaction
        }
        throw error;
      }
      log("warn", "engine store: damaged records set aside", { count: result.repaired.length, repaired: result.repaired, saved, backup: result.backup });
    }
    try {
      await writeFileAtomic(markerFile, `${JSON.stringify({ file, ...highWater, at: new Date(now()).toISOString() })}\n`);
    } catch {
      // checked in full again next time
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    log("warn", "engine store check skipped", { error: result.error });
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
  return result;
}

const running = new Map<string, Promise<EngineStoreRepairResult>>();
/** The stores of the engines this process started, for repairs while they run. */
const knownStores = new Map<string, EngineStoreRepairLog | undefined>();
const LIVE_REPAIR_INTERVAL_MS = 30_000;
let lastLiveRepair = 0;

function repairOnce(file: string, log?: EngineStoreRepairLog): Promise<EngineStoreRepairResult> {
  const pending = running.get(file);
  if (pending) return pending;
  const started = repairEngineStore({ file, log }).finally(() => running.delete(file));
  running.set(file, started);
  return started;
}

/**
 * A 500 "Unexpected server error" on a session read, while the engine runs:
 * the engine reads the session store on every request, so a damaged row set
 * aside now is fixed for the next request, without a restart. Checks the
 * stores of the engines this process started, at most every 30 s. Resolves
 * the number of records set aside. Never throws.
 */
export async function repairEngineStoresAfterServerError(now: () => number = Date.now): Promise<number> {
  if (!knownStores.size) return 0;
  if (now() - lastLiveRepair < LIVE_REPAIR_INTERVAL_MS) return 0;
  lastLiveRepair = now();
  let repaired = 0;
  for (const [file, log] of knownStores) {
    try {
      repaired += (await repairOnce(file, log)).repaired.length;
    } catch {
      // repairEngineStore never throws; a store that went away is skipped
    }
  }
  return repaired;
}

/** Tests: forget the stores and the throttle. */
export function resetEngineStoreRepairState(): void {
  knownStores.clear();
  lastLiveRepair = 0;
}

/**
 * repairEngineStore for an engine about to start: engines started together
 * (the engine pool) share one check of their store.
 */
export function repairEngineStoreBeforeStart(env: NodeJS.ProcessEnv, log?: EngineStoreRepairLog): Promise<EngineStoreRepairResult> {
  const file = engineStorePath(env);
  if (!file) return Promise.resolve({ checked: false, repaired: [], saved: null, backup: null });
  knownStores.set(file, log);
  return repairOnce(file, log);
}
