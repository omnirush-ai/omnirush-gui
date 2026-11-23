// Telegram from the user's own account, through Telegram's official API (MTProto, via teleproto: the maintained MIT
// fork of GramJS, its dependencies MIT, ISC, BSD or Unlicense), which allows third-party clients. Sign-in happens on
// this device (phone, the code Telegram sends, the two-step password if set). The login (a StringSession) is
// encrypted with safeStorage and kept only in
// <userData>/work-telegram.json: never sent to the server, never logged. The chat sync (work-chat-sync.mjs) calls
// `read` at app start and every 10 minutes and pushes the chat-days to /work/telegram: private chats (no bots) and
// groups (channels when the setting adds them), text, captions and file names (no media bytes), one record per chat
// per UTC day under the chat's bare id, the id Telegram Desktop's result.json export uses, so the import and the sync
// land on the same records. Requests are paced and FLOOD_WAIT is honoured, so the account is never flagged.

import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cut, MAX_DAY_TEXT } from "./work-imessage.mjs";

export const TELEGRAM_FILE = "work-telegram.json";
// The app's Telegram credentials (my.telegram.org), written at build time by scripts/electron-build.mjs from
// OMNIRUSH_TELEGRAM_API_ID and OMNIRUSH_TELEGRAM_API_HASH; without them the feature stays hidden.
export const TELEGRAM_BUILD_FILE = "omnirush-telegram.json";
export const FIRST_DAYS = 90;
// One request a second; a FLOOD_WAIT up to a minute is waited out, a longer one ends the run until it is over.
export const GAP_MS = 1_000;
export const MAX_WAIT_S = 60;
// A run starts no new chat after this many requests (a chat is always read to its end); the rest go next run.
export const RUN_REQUESTS = 300;
const PAGE = 100;
const DAY_S = 86_400;
// The server's caps on one chat-day (backend imports.py).
const MAX_DAY_MESSAGES = 5000;
// Telegram's own service chat carries login codes: never synced.
const SERVICE_USER = "777000";
const LOGIN_TTL_MS = 15 * 60_000;
// GramJS-style clients can wait forever on a request when the connection is gone: each request and disconnect gets this long.
const REQUEST_MS = 90_000;

/** `{ apiId, apiHash }` from the build file (a path) or an object; null when missing or malformed. */
export function telegramCredentials(source) {
  let found = source;
  if (typeof source === "string") {
    try {
      found = JSON.parse(readFileSync(source, "utf8"));
    } catch {
      return null;
    }
  }
  const apiId = Number(found?.apiId);
  const apiHash = String(found?.apiHash ?? "").trim();
  return Number.isInteger(apiId) && apiId > 0 && /^[0-9a-f]{32}$/i.test(apiHash) ? { apiId, apiHash } : null;
}

/** A tagged error: the card shows its code; `retryAfterMs` for flood_wait. */
export class TelegramError extends Error {
  constructor(code, retryAfterMs = 0) {
    super(code);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The seconds of a FLOOD_WAIT or FLOOD_PREMIUM_WAIT (FloodWaitError; teleproto keeps Telegram's own message, "FLOOD_WAIT_42"), or null. */
export function floodSeconds(error) {
  return /^FLOOD($|_)/.test(String(error?.errorMessage ?? "")) && Number.isFinite(error.seconds) ? error.seconds : null;
}

function loginError(error) {
  if (error instanceof TelegramError) return error;
  const seconds = floodSeconds(error);
  if (seconds !== null) return new TelegramError("flood_wait", seconds * 1000);
  const message = String(error?.errorMessage ?? "");
  if (message === "PHONE_NUMBER_FLOOD") return new TelegramError("flood_wait");
  if (message.startsWith("PHONE_NUMBER_")) return new TelegramError("bad_phone");
  if (message === "PHONE_CODE_INVALID" || message === "PHONE_CODE_EMPTY") return new TelegramError("wrong_code");
  if (message === "PHONE_CODE_EXPIRED") return new TelegramError("code_expired");
  if (message === "PASSWORD_HASH_INVALID") return new TelegramError("wrong_password");
  return new TelegramError("failed");
}

/** A user's name as Telegram Desktop's export writes it (first and last), a chat's title. */
export function nameOf(entity) {
  if (!entity) return "";
  if (entity.className === "User") return [entity.firstName, entity.lastName].filter(Boolean).join(" ");
  return entity.title ?? "";
}

/** Private chats (not the service chat, not bots: noise, and BotFather's replies carry bot tokens) and groups;
 *  broadcast channels only with `channels`. */
function wanted(entity, channels) {
  if (entity?.className === "User") return String(entity.id) !== SERVICE_USER && !entity.bot;
  if (entity?.className === "Chat") return !entity.deactivated && !entity.left;
  if (entity?.className === "Channel") return !entity.broadcast || channels;
  return false; // forbidden or empty chats
}

/** `promise`, or a TelegramError("timeout") after REQUEST_MS. */
function timed(promise) {
  let timer;
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new TelegramError("timeout")), REQUEST_MS);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Connects `client`; a failed or hung connect means Telegram cannot be reached (and requests would then wait for ever). */
async function online(client) {
  const up = await timed(client.connect()).catch(() => false);
  if (up !== false) return client;
  await close(client);
  throw new TelegramError("offline");
}

const ask = (client, request) => timed(client.invoke(request));
const close = (client) => (client ? timed(client.destroy()).catch(() => undefined) : undefined);

const dayStart = (seconds) => Math.floor(seconds / DAY_S) * DAY_S;
const dayOf = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);

/** One message as the server takes it (the export's fields): text or caption, a photo flag, a file name. */
export function messageRow(message, sender) {
  if (message?.className !== "Message") return null; // service lines and empty slots
  const row = { id: message.id, date: message.date, text: message.message || "" };
  if (sender) row.from = cut(sender, 256);
  const media = message.media;
  const doc = media?.className === "MessageMediaDocument" ? media.document : null;
  if (media?.className === "MessageMediaPhoto") row.photo = true;
  else if (doc?.className === "Document") {
    const attrs = doc.attributes ?? [];
    const has = (name, flag) => attrs.some((a) => a.className === name && (!flag || a[flag]));
    const file = attrs.find((a) => a.className === "DocumentAttributeFilename")?.fileName;
    if (file && !has("DocumentAttributeSticker")) row.file_name = cut(file, 512);
    else row.media_type = has("DocumentAttributeSticker") ? "sticker" : has("DocumentAttributeAudio", "voice") ? "voice_message"
      : has("DocumentAttributeVideo", "roundMessage") ? "video_message" : cut(doc.mimeType || "file", 64);
  } else if (media && !["MessageMediaEmpty", "MessageMediaWebPage"].includes(media.className)) {
    row.media_type = media.className.replace("MessageMedia", "").toLowerCase().slice(0, 64);
  }
  return row;
}

/** A chat-day sorted by time and cut to the server's caps (the earliest messages are kept). */
function finishDay(record) {
  record.messages.sort((a, b) => a.date - b.date || a.id - b.id);
  const kept = [];
  let chars = 0;
  for (const message of record.messages) {
    if (kept.length >= MAX_DAY_MESSAGES || chars >= MAX_DAY_TEXT) break;
    const text = cut(message.text, MAX_DAY_TEXT - chars);
    chars += text.length;
    kept.push({ ...message, text });
  }
  return { ...record, messages: kept };
}

/** The real client: teleproto over TCP, its log off (it would print connection details), no automatic flood sleeps. */
async function openGram(credentials, session, appVersion, testServers) {
  const { TelegramClient, sessions, Logger } = (await import("teleproto")).default;
  return new TelegramClient(new sessions.StringSession(session), credentials.apiId, credentials.apiHash, {
    testServers,
    connectionRetries: 3,
    floodSleepThreshold: 0,
    deviceModel: "OmniRush.ai",
    systemVersion: `${os.type()} ${os.release()}`,
    appVersion: appVersion || "1.0",
    baseLogger: new Logger(/** @type {any} */ ("none")),
  });
}

async function realCheck(srp, password) {
  return (await import("teleproto")).default.password.computeCheck(srp, password);
}

/**
 * @param {{
 *   credentials: { apiId: number, apiHash: string } | null,
 *   file: string,
 *   storage: () => Promise<{ encrypt: (text: string) => Promise<Buffer>, decrypt: (data: Buffer) => Promise<string> } | null>,
 *   open?: (session: string) => Promise<any>,
 *   computeCheck?: (srp: any, password: string) => Promise<any>,
 *   appVersion?: string,
 *   testServers?: boolean,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 */
export function createTelegram(deps) {
  const {
    credentials, file, storage,
    // testServers: Telegram's test DC, only for live tests that drive this module from Node; main.mjs never sets it.
    open = (session) => openGram(/** @type {any} */ (credentials), session, deps.appVersion, deps.testServers === true),
    computeCheck = realCheck,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;
  const gram = async () => (await import("teleproto")).default;
  /** The sign-in in progress (between the code and the password), for one Work account. */
  let pending = null;

  async function load() {
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      return saved && typeof saved.session === "string" ? saved : null;
    } catch {
      return null;
    }
  }

  async function save(saved) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
    await rename(temp, file);
  }

  async function keys() {
    const found = await storage().catch(() => null);
    if (!found) throw new TelegramError("no_keyring");
    return found;
  }

  async function drop() {
    const was = pending;
    pending = null;
    await close(was?.client);
  }

  /** @returns {Promise<{ step: "done" }>} */
  async function finish(client, user, account) {
    const session = await (await keys()).encrypt(client.session.save());
    const previous = await load();
    await save({
      account,
      user: { id: String(user.id), name: nameOf(user) },
      session: session.toString("base64"),
      channels: previous?.channels === true,
      days: previous?.days ?? FIRST_DAYS,
    });
    await drop();
    return { step: "done" };
  }

  /** A connected client on the saved login; a login Telegram ended (another device signed it out) is removed here. */
  async function connected(saved) {
    return online(await open(await (await keys()).decrypt(Buffer.from(saved.session, "base64"))));
  }

  async function signedOutBy(error) {
    if (error?.code !== 401) return false;
    await rm(file, { force: true });
    return true;
  }

  return {
    available: Boolean(credentials),

    /**
     * The card's state for the Work account `account`.
     * @returns {Promise<import("@omnirush/types/desktop-ipc").WorkTelegramStatus>}
     */
    async status(account) {
      if (!credentials) return { available: false };
      // The Work account is not known yet (offline at start, signed out): nothing is shown, so a login is never taken
      // for another account's and offered a Disconnect that could not end it on Telegram.
      if (!account) return { available: false };
      if (pending && now() - pending.at > LOGIN_TTL_MS) await drop();
      const saved = await load();
      const mine = saved && saved.account === account;
      const step = pending && pending.account === account ? pending.step : mine ? "signed_in" : saved ? "other_account" : "signed_out";
      return {
        available: true,
        step,
        name: mine ? saved.user?.name || null : null,
        via: step === "code" ? pending.via : null,
        hint: step === "password" ? pending.hint || null : null,
        channels: mine ? saved.channels === true : false,
        days: mine ? saved.days ?? FIRST_DAYS : FIRST_DAYS,
      };
    },

    /**
     * One sign-in step: `{ phone }` sends the code, `{ code }` signs in (or asks for the password), `{ password }`
     * finishes a two-step login, `{ cancel: true }` drops it. Returns the next step, or `{ error }` (the step stays).
     * @returns {Promise<import("@omnirush/types/desktop-ipc").WorkTelegramLoginResult>}
     */
    async login(input, account) {
      try {
        if (!credentials) throw new TelegramError("unavailable");
        if (input?.cancel) {
          await drop();
          return { step: "signed_out" };
        }
        if (!account) throw new TelegramError("work_off");
        if (typeof input?.phone === "string") {
          const phone = input.phone.replace(/[\s().-]/g, "");
          if (!/^\+?\d{7,15}$/.test(phone)) throw new TelegramError("bad_phone");
          await keys();
          await drop();
          const client = await online(await open(""));
          try {
            const sent = await timed(client.sendCode(credentials, phone));
            const via = sent.isCodeViaApp ? "app" : "sms";
            pending = { client, account, phone, hash: sent.phoneCodeHash, via, step: "code", hint: null, at: now() };
            return { step: "code", via };
          } catch (error) {
            await close(client);
            throw error;
          }
        }
        if (!pending || pending.account !== account || now() - pending.at > LOGIN_TTL_MS) {
          await drop();
          throw new TelegramError("code_expired");
        }
        const { Api } = await gram();
        const { client } = pending;
        if (pending.step === "code" && typeof input?.code === "string") {
          let result;
          try {
            result = await ask(client, new Api.auth.SignIn({ phoneNumber: pending.phone, phoneCodeHash: pending.hash, phoneCode: input.code.replace(/\D/g, "") }));
          } catch (error) {
            if (error?.errorMessage !== "SESSION_PASSWORD_NEEDED") throw error;
            const srp = await ask(client, new Api.account.GetPassword());
            Object.assign(pending, { step: "password", hint: srp.hint ?? null });
            return { step: "password", hint: pending.hint };
          }
          // A number with no Telegram account: signing up is left to Telegram's own apps.
          if (result.className === "auth.AuthorizationSignUpRequired") throw new TelegramError("not_registered");
          return await finish(client, result.user, account);
        }
        if (pending.step === "password" && typeof input?.password === "string") {
          const srp = await ask(client, new Api.account.GetPassword());
          const result = await ask(client, new Api.auth.CheckPassword({ password: await computeCheck(srp, input.password) }));
          return await finish(client, result.user, account);
        }
        throw new TelegramError("failed");
      } catch (error) {
        const failed = loginError(error);
        if (["code_expired", "not_registered"].includes(failed.code)) await drop();
        return { error: failed.code, ...(failed.retryAfterMs ? { waitSeconds: Math.ceil(failed.retryAfterMs / 1000) } : {}) };
      }
    },

    /** Disconnect: Telegram ends the login (auth.logOut, best effort when offline) and the local file goes. */
    async logout() {
      await drop();
      const saved = await load();
      if (saved) {
        try {
          const client = await connected(saved);
          try {
            await ask(client, new (await gram()).Api.auth.LogOut());
          } finally {
            await close(client);
          }
        } catch {
          // Offline, or Telegram already ended it: the local login is deleted all the same.
        }
      }
      await rm(file, { force: true });
    },

    /** The settings of this account's login: `channels` adds broadcast channels, `days` is how far the first sync goes back. */
    async setSettings(change, account) {
      const saved = await load();
      if (!saved || saved.account !== account) return;
      if (typeof change?.channels === "boolean") saved.channels = change.channels;
      if (Number.isInteger(change?.days) && change.days >= 1 && change.days <= 365) saved.days = change.days;
      await save(saved);
    },

    /**
     * The chat-days since `cursor` for the chat sync. Newest first per chat: the new messages, then the rest of the
     * oldest new message's day (the server replaces a chat-day's record); a chat never read goes back `days`. Only
     * the dialogs whose last message is past the previous run are read. A chat's days come together, so `cursorAt(n)`
     * (the cursor once the first `n` landed) moves each chat whose days all landed and keeps the rest where they were.
     * Throws signed_out, other_account, no_keyring.
     * @returns {Promise<{ records: object[], cursor: object, messageCount: number, retryAfterMs?: number, cursorAt: (n: number) => object }>}
     */
    async read(cursor, account) {
      const saved = await load();
      if (!saved) throw new TelegramError("signed_out");
      if (saved.account !== account) throw new TelegramError("other_account");
      const { Api, utils, helpers } = await gram();
      const zero = helpers.returnBigInt(0);
      const me = saved.user ?? {};
      const start = Math.floor(now() / 1000);
      const fresh = cursor && cursor.user === me.id && typeof cursor.chats === "object" ? cursor : { user: me.id, chats: {} };
      const cutoff = dayStart(start - (saved.days ?? FIRST_DAYS) * DAY_S);
      const channels = saved.channels === true;
      // Dialogs come newest first: those last written before the previous run (an hour of slack) have nothing new.
      const floor = fresh.at && fresh.channels === channels ? Math.max(fresh.at - 3600, cutoff) : cutoff;
      const chats = { ...fresh.chats };
      const days = new Map();
      let requests = 0;
      let lastCall = 0;
      let messageCount = 0;
      let complete = true;
      let retryAfterMs = 0;

      async function call(client, request) {
        requests += 1;
        for (let tries = 0; ; tries += 1) {
          const wait = lastCall + GAP_MS - now();
          if (wait > 0) await sleep(wait);
          lastCall = now();
          try {
            return await ask(client, request);
          } catch (error) {
            const seconds = floodSeconds(error);
            if (seconds === null) throw error;
            if (seconds > MAX_WAIT_S || tries >= 2) throw new TelegramError("flood_wait", (seconds + 1) * 1000);
            await sleep((seconds + 1) * 1000);
          }
        }
      }

      /** One chat, newest first; its rows go into `days` only when it is read to the end. */
      async function readChat(client, entity) {
        const id = String(entity.id);
        const last = Number(chats[id]) || 0;
        const peer = utils.getInputPeer(entity);
        const rows = [];
        let top = last;
        let fromDay = null;
        let offsetId = 0;
        let added = 0;
        for (let stop = false; !stop;) {
          const page = await call(client, new Api.messages.GetHistory({ peer, offsetId, offsetDate: 0, addOffset: 0, limit: PAGE, maxId: 0, minId: 0, hash: zero }));
          const names = new Map([...(page.users ?? []), ...(page.chats ?? [])].map((e) => [utils.getPeerId(e), nameOf(e)]));
          const messages = page.messages ?? [];
          stop = messages.length < PAGE;
          for (const message of messages) {
            offsetId = message.id;
            if (message.className === "MessageEmpty") continue;
            // Past the cut-off, or an old message before the oldest new message's day: this chat is done.
            if (message.date < cutoff || (message.id <= last && (fromDay === null || message.date < fromDay))) {
              stop = true;
              break;
            }
            if (message.id > last) {
              top = Math.max(top, message.id);
              fromDay = dayStart(message.date);
            }
            const sender = message.out ? me.name : message.fromId ? names.get(utils.getPeerId(message.fromId)) : nameOf(entity);
            const row = messageRow(message, sender);
            if (!row) continue;
            if (message.id > last) added += 1;
            rows.push(row);
          }
        }
        for (const row of rows) {
          const day = dayOf(row.date);
          const key = `${id}\u0000${day}`;
          if (!days.has(key)) days.set(key, { chat_id: id, chat_name: cut(nameOf(entity), 512) || null, day, messages: [] });
          days.get(key).messages.push(row);
        }
        chats[id] = top;
        messageCount += added;
      }

      let client;
      try {
        client = await connected(saved);
        const seen = new Set();
        /** @type {{ offsetDate: number, offsetId: number, offsetPeer: any }} */
        let offset = { offsetDate: 0, offsetId: 0, offsetPeer: new Api.InputPeerEmpty() };
        pages: for (;;) {
          const page = await call(client, new Api.messages.GetDialogs({ ...offset, limit: PAGE, hash: zero }));
          const entities = new Map([...(page.users ?? []), ...(page.chats ?? [])].map((e) => [utils.getPeerId(e), e]));
          const tops = new Map((page.messages ?? []).map((m) => [`${utils.getPeerId(m.peerId)}:${m.id}`, m]));
          let lastSeen = null;
          for (const dialog of page.dialogs ?? []) {
            const peerId = utils.getPeerId(dialog.peer);
            const entity = entities.get(peerId);
            const top = tops.get(`${peerId}:${dialog.topMessage}`);
            if (!top || !entity) continue;
            lastSeen = { top, entity };
            if (!dialog.pinned && top.date < floor) break pages;
            if (seen.has(peerId) || !wanted(entity, channels)) continue;
            seen.add(peerId);
            if (dialog.topMessage <= (Number(chats[String(entity.id)]) || 0)) continue;
            if (requests >= RUN_REQUESTS) {
              complete = false;
              break pages;
            }
            try {
              await readChat(client, entity);
            } catch (error) {
              // A chat Telegram refuses (left, banned, private) is skipped and tried next run; the rest go on.
              if (error instanceof TelegramError || error?.code === 401 || !error?.errorMessage) throw error;
            }
          }
          if (page.className === "messages.Dialogs" || (page.dialogs ?? []).length < PAGE || !lastSeen) break;
          if (lastSeen.top.id === offset.offsetId && lastSeen.top.date === offset.offsetDate) break; // no progress
          offset = { offsetDate: lastSeen.top.date, offsetId: lastSeen.top.id, offsetPeer: utils.getInputPeer(lastSeen.entity) };
        }
      } catch (error) {
        if (await signedOutBy(error)) throw new TelegramError("signed_out");
        if (!(error instanceof TelegramError && error.code === "flood_wait")) throw error;
        // The chats read so far are kept; the rest wait for Telegram's time.
        complete = false;
        retryAfterMs = error.retryAfterMs;
      } finally {
        await close(client);
      }
      const records = [...days.values()].map(finishDay);
      // An unfinished run keeps the previous floor, so the chats it did not reach are found next time.
      const next = { user: me.id, channels, at: complete ? start : fresh.at ?? null, chats };
      return {
        records,
        cursor: next,
        messageCount,
        ...(retryAfterMs ? { retryAfterMs } : {}),
        // Part of it landed: the previous floor and setting stay, so every chat still to send is read again next run.
        cursorAt: (n) => {
          if (n >= records.length) return next;
          const waiting = new Set(records.slice(n).map((record) => record.chat_id));
          const kept = Object.entries(chats).map(([id, top]) => [id, waiting.has(id) ? fresh.chats[id] : top]).filter(([, top]) => top !== undefined);
          return { user: me.id, ...(fresh.channels === undefined ? {} : { channels: fresh.channels }), at: fresh.at ?? null, chats: Object.fromEntries(kept) };
        },
      };
    },
  };
}
