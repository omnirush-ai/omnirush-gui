// Hackathon events from /device/me: the same file in omnirush-cli (assets/extensions/omnirush/events/) and
// omnirush-gui (apps/desktop/electron/events/); keep them byte-identical (PARITY.sha256).
//
//   "events": {
//     "active":  [{ "name", "code", "starts_at", "ends_at", "stock_required" }],
//     "history": [{ "name", "code", "joined_at" }]
//   },
//   "stock_mode": { "required": true, "reason": "event", "event": "BIOS V2" }
//
// Display only, and never waited on: a missing or malformed block (or entry) reads as no event. An event is
// active from starts_at (when given) until ends_at, by this machine's clock. stock_mode.required counts only
// while an event is active, so the app goes back to its normal mode once the event ends, also with an old answer.

const NAME_MAX = 60;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value, max) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
/** An ISO time as ms, null when absent, NaN when present but unreadable. */
const time = (value) => (value === undefined || value === null ? null : typeof value === "string" ? Date.parse(value) : Number.NaN);

/**
 * { active, history, stock } from a /device/me answer (or the part of one an app kept):
 *   active   [{ name, code, startsAt, endsAt }] running now, the one ending first first
 *   history  [{ name, code, joinedAt }] newest first
 *   stock    { event, until } while the server requires its mode for an active event, else null
 */
export function parseEvents(me, now = Date.now()) {
  const block = isRecord(me) && isRecord(me.events) ? me.events : {};
  const entries = (value) => (Array.isArray(value) ? value.filter(isRecord) : []);
  const active = [];
  for (const entry of entries(block.active)) {
    const name = text(entry.name, NAME_MAX);
    const startsAt = time(entry.starts_at);
    const endsAt = time(entry.ends_at);
    if (!name || !Number.isFinite(endsAt) || Number.isNaN(startsAt)) continue;
    if (endsAt <= now || (startsAt !== null && startsAt > now)) continue;
    active.push({ name, code: text(entry.code, 40), startsAt, endsAt, stockRequired: entry.stock_required === true });
  }
  active.sort((a, b) => a.endsAt - b.endsAt);
  const history = [];
  for (const entry of entries(block.history)) {
    const name = text(entry.name, NAME_MAX);
    const joinedAt = time(entry.joined_at);
    if (name && Number.isFinite(joinedAt)) history.push({ name, code: text(entry.code, 40), joinedAt });
  }
  history.sort((a, b) => b.joinedAt - a.joinedAt);
  let stock = null;
  if (isRecord(me) && isRecord(me.stock_mode) && me.stock_mode.required === true && active.length) {
    const named = text(me.stock_mode.event, NAME_MAX);
    const event = active.find((item) => item.name === named) ?? active.find((item) => item.stockRequired) ?? active[0];
    stock = { event: event.name, until: event.endsAt };
  }
  return {
    active: active.map(({ stockRequired: _s, ...item }) => item),
    history,
    stock,
  };
}

/** The part of an answer worth keeping on disk (the next start decides its mode before it can ask). */
export function eventsRecord(me) {
  return isRecord(me) ? { events: isRecord(me.events) ? me.events : null, stock_mode: isRecord(me.stock_mode) ? me.stock_mode : null } : null;
}

function format(at, options, { locale, timeZone } = {}) {
  const zone = timeZone ? { timeZone } : {};
  try {
    return new Intl.DateTimeFormat(locale, { ...options, ...zone }).format(at).replace(/[  ]/g, " ");
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, ...zone }).format(at).replace(/[  ]/g, " ");
  }
}

function dayNumber(at, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "numeric", day: "numeric", ...(timeZone ? { timeZone } : {}) }).formatToParts(at);
  const part = (type) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000;
}

/** "ends today 6:00 PM", "ends tomorrow 6:00 PM", "ends Fri 6:00 PM", "ends Nov 7" (local time). */
export function endsLabel(at, now = Date.now(), local = {}) {
  const clock = format(at, { hour: "numeric", minute: "2-digit" }, local);
  const days = dayNumber(at, local.timeZone) - dayNumber(now, local.timeZone);
  if (days <= 0) return `ends today ${clock}`;
  if (days === 1) return `ends tomorrow ${clock}`;
  if (days < 7) return `ends ${format(at, { weekday: "short" }, local)} ${clock}`;
  return `ends ${format(at, { month: "short", day: "numeric" }, local)}`;
}

/** "Oct 29, 2026" (local date). */
export function dateLabel(at, local = {}) {
  return format(at, { month: "short", day: "numeric", year: "numeric" }, local);
}

/** The words both apps show for an active event: { title, detail }. */
export function eventBadge(event, now = Date.now(), local = {}) {
  return { title: `${event.name} hackathon`, detail: `You're participating · ${endsLabel(event.endsAt, now, local)}` };
}
