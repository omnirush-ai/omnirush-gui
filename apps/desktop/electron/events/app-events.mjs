// Hackathon events in the desktop app (events.mjs parses /device/me's block, the same file as the CLI's).
// The last answer's part is kept in <userData>/events.json, so the next start knows before anything runs
// whether an event runs its chats in stock mode (applyEventStock, from main.mjs), and the window gets the
// display values with the account status (accountEvents). Display only: nothing here reaches a chat, the
// agent's env or uploads; a missing or malformed block shows nothing.

import fs from "node:fs";
import path from "node:path";

import { dateLabel, eventBadge, eventsRecord, parseEvents } from "./events.mjs";

const FILE = "events.json";
const STOCK_ENV = "OMNIRUSH_FARM";
/** Set at start when an event turned the mode on: the window's stock-mode notice stays quiet then. */
export const EVENT_MODE_ENV = "OMNIRUSH_STOCK_REASON";

const stockMode = (env) => ["1", "true", "on", "yes"].includes(String(env?.[STOCK_ENV] ?? "").trim().toLowerCase());

export function readEventsRecord(dir) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf8"));
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

function saveEventsRecord(dir, record) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, FILE);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch { /* the next answer is kept instead */ }
}

/**
 * At start, before anything reads OMNIRUSH_FARM: an event that runs its chats in stock mode (the kept answer)
 * turns it on for this run, whatever the launch env says. Returns { asked, event, stock }.
 */
export function applyEventStock(dir, env = process.env, now = Date.now()) {
  // A relaunch inherits this process's env: the mode an event turned on is not the person's own.
  if (env[EVENT_MODE_ENV] === "event") delete env[STOCK_ENV];
  delete env[EVENT_MODE_ENV];
  const asked = stockMode(env);
  const event = Boolean(parseEvents(readEventsRecord(dir), now).stock);
  if (event) {
    env[EVENT_MODE_ENV] = asked ? "event-asked" : "event";
    env[STOCK_ENV] = "1";
  }
  return { asked, event, stock: asked || event };
}

/**
 * The account status as the window gets it: the profile's raw `eventsRecord` is kept on disk and replaced by
 * `events` ({ active, joined, restart }; empty lists when the account has none; null to show nothing at all). `started` is applyEventStock's answer.
 * `restart`: an event now asks for the mode this run did not start in; it applies from the next start.
 */
export function accountEvents(status, { dir, started, now = Date.now(), local } = {}) {
  if (!status || typeof status !== "object") return status;
  const { eventsRecord: record, ...rest } = status;
  if (record) saveEventsRecord(dir, record);
  if (!rest.connected) return { ...rest, events: null };
  const parsed = parseEvents(record ?? readEventsRecord(dir), now);
  // A stock run for any other reason stays as plain as stock OpenCode.
  if (started?.stock && !started.event && !parsed.stock) return { ...rest, events: null };
  return {
    ...rest,
    events: {
      active: parsed.active.map((event) => ({ name: event.name, endsAt: new Date(event.endsAt).toISOString(), ...eventBadge(event, now, local) })),
      joined: parsed.history.map((event) => ({ name: event.name, joinedAt: new Date(event.joinedAt).toISOString(), date: dateLabel(event.joinedAt, local) })),
      restart: Boolean(parsed.stock) && !started?.stock,
    },
  };
}

export { eventsRecord };
