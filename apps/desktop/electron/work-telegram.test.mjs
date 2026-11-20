import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import telegram from "teleproto";

import { createTelegram, GAP_MS, messageRow, telegramCredentials } from "./work-telegram.mjs";

const { Api, errors, helpers } = telegram;
const big = (n) => helpers.returnBigInt(n);
// A FLOOD_WAIT as it reaches the code: teleproto keeps Telegram's message ("FLOOD_WAIT_300") on the FloodWaitError.
const flood = (seconds) => errors.RPCMessageToError(new Api.RpcError({ errorCode: 420, errorMessage: `FLOOD_WAIT_${seconds}` }), null);
const DAY = 86_400;
// 2026-11-20 10:00 UTC
const NOW = Date.parse("2026-11-20T10:00:00Z");
const at = (iso) => Math.floor(Date.parse(iso) / 1000);
const CREDENTIALS = { apiId: 12345, apiHash: "0123456789abcdef0123456789abcdef" };
const SESSION = "1BVtsOK8Bu-secret-session";

const me = new Api.User({ id: big(42), firstName: "Sam", lastName: "Rao", accessHash: big(1), self: true });
const ann = new Api.User({ id: big(777), firstName: "Ann", lastName: "Buyer", accessHash: big(2) });
const bob = new Api.User({ id: big(888), firstName: "Bob", accessHash: big(3) });
const service = new Api.User({ id: big(777000), firstName: "Telegram", accessHash: big(4) });
const group = new Api.Channel({ id: big(123), title: "Ops", megagroup: true, accessHash: big(5), photo: new Api.ChatPhotoEmpty(), date: 0 });
const news = new Api.Channel({ id: big(456), title: "News", broadcast: true, accessHash: big(6), photo: new Api.ChatPhotoEmpty(), date: 0 });
const basic = new Api.Chat({ id: big(55), title: "Old group", photo: new Api.ChatPhotoEmpty(), participantsCount: 3, date: 0, version: 1 });

const peerOf = (entity) => (entity.className === "User" ? new Api.PeerUser({ userId: entity.id })
  : entity.className === "Chat" ? new Api.PeerChat({ chatId: entity.id }) : new Api.PeerChannel({ channelId: entity.id }));

/** A fake Telegram: chats with messages, a login with a code and an optional password, injected errors. */
function fakeTelegram() {
  const chats = new Map();
  const server = {
    chats,
    calls: [],
    errors: [],
    code: "12345",
    password: null,
    loggedOut: 0,
    sendCodeError: null,
    add(entity, message) {
      const chat = chats.get(entity) ?? [];
      chats.set(entity, chat);
      chat.push(new Api.Message({ peerId: peerOf(entity), ...message }));
    },
  };
  const entities = () => [me, ann, bob, service, group, news, basic];
  const find = (peer) => [...chats.keys()].find((e) => String(e.id) === String(peer.userId ?? peer.chatId ?? peer.channelId));
  server.client = () => ({
    session: { save: () => SESSION },
    connected: false,
    destroyed: false,
    async connect() {
      // A client that cannot reach Telegram fails its connect.
      if (server.offline) return false;
      this.connected = true;
      return true;
    },
    async destroy() {
      this.destroyed = true;
    },
    async sendCode(credentials, phone) {
      assert.deepEqual(credentials, CREDENTIALS);
      server.calls.push(`sendCode ${phone}`);
      if (server.sendCodeError) throw server.sendCodeError;
      return { phoneCodeHash: "hash1", isCodeViaApp: true };
    },
    async invoke(request) {
      assert.ok(this.connected, "invoke before connect");
      server.calls.push(request.className);
      const injected = server.errors.shift();
      if (injected) throw injected;
      switch (request.className) {
        case "auth.SignIn":
          assert.equal(request.phoneCodeHash, "hash1");
          if (request.phoneCode !== server.code) throw new errors.RPCError("PHONE_CODE_INVALID", request, 400);
          if (server.password) throw new errors.RPCError("SESSION_PASSWORD_NEEDED", request, 401);
          return { className: "auth.Authorization", user: me };
        case "account.GetPassword":
          return { className: "account.Password", hint: "pet" };
        case "auth.CheckPassword":
          if (request.password.typed !== server.password) throw new errors.RPCError("PASSWORD_HASH_INVALID", request, 400);
          return { className: "auth.Authorization", user: me };
        case "auth.LogOut":
          server.loggedOut += 1;
          return { className: "auth.LoggedOut" };
        case "messages.GetDialogs": {
          // Newest first, like Telegram; one page holds everything here (a short page ends the listing).
          const dialogs = [...chats.entries()].map(([entity, list]) => ({ entity, top: list.reduce((a, b) => (b.id > a.id ? b : a)) }))
            .sort((a, b) => b.top.date - a.top.date);
          return {
            className: "messages.DialogsSlice",
            dialogs: dialogs.map(({ entity, top }) => ({ className: "Dialog", peer: peerOf(entity), topMessage: top.id })),
            messages: dialogs.map((d) => d.top),
            users: entities().filter((e) => e.className === "User"),
            chats: entities().filter((e) => e.className !== "User"),
          };
        }
        case "messages.GetHistory": {
          const list = [...(chats.get(find(request.peer)) ?? [])].sort((a, b) => b.id - a.id)
            .filter((m) => !request.offsetId || m.id < request.offsetId).slice(0, request.limit);
          server.calls.push(`history ${String(find(request.peer).id)} from ${request.offsetId}`);
          return { className: "messages.ChannelMessages", messages: list, users: entities().filter((e) => e.className === "User"), chats: [] };
        }
        default:
          throw new Error(`unexpected ${request.className}`);
      }
    },
  });
  return server;
}

function rig() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-telegram-"));
  const file = path.join(dir, "work-telegram.json");
  const server = fakeTelegram();
  const clients = [];
  const clock = { now: NOW, sleeps: [] };
  const tg = createTelegram({
    credentials: CREDENTIALS,
    file,
    storage: async () => ({ encrypt: async (text) => Buffer.from(`enc:${text}`), decrypt: async (data) => data.toString().slice(4) }),
    open: async (session) => {
      const client = server.client();
      client.opened = session;
      clients.push(client);
      return client;
    },
    computeCheck: async (_srp, typed) => ({ typed }),
    now: () => clock.now,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      clock.now += ms;
    },
  });
  return { tg, server, file, clock, clients, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The card's state, any shape (the IPC type is a union with `{ available: false }`). */
const statusOf = async (r, account) => /** @type {any} */ (await r.tg.status(account));

async function signIn(r, account = "acct_a") {
  assert.deepEqual(await r.tg.login({ phone: "+44 7700 900123" }, account), { step: "code", via: "app" });
  assert.deepEqual(await r.tg.login({ code: "12345" }, account), { step: "done" });
}

test("sign-in: phone, a wrong code, the right one; only the encrypted login is kept", async () => {
  const r = rig();
  try {
    assert.equal((await statusOf(r, "acct_a")).step, "signed_out");
    assert.deepEqual(await r.tg.login({ phone: "12" }, "acct_a"), { error: "bad_phone" });
    assert.deepEqual(await r.tg.login({ phone: "+44 7700 900123" }, null), { error: "work_off" });
    assert.deepEqual(await r.tg.login({ phone: "+44 7700 900123" }, "acct_a"), { step: "code", via: "app" });
    assert.equal(r.server.calls[0], "sendCode +447700900123");
    assert.deepEqual(await statusOf(r, "acct_a"), { available: true, step: "code", name: null, via: "app", hint: null, channels: false, days: 90 });
    assert.deepEqual(await r.tg.login({ code: "11111" }, "acct_a"), { error: "wrong_code" });
    assert.equal((await statusOf(r, "acct_a")).step, "code", "a wrong code keeps the step");
    assert.deepEqual(await r.tg.login({ code: "12 345" }, "acct_a"), { step: "done" });
    const saved = JSON.parse(readFileSync(r.file, "utf8"));
    assert.equal(saved.account, "acct_a");
    assert.deepEqual(saved.user, { id: "42", name: "Sam Rao" });
    assert.equal(Buffer.from(saved.session, "base64").toString(), `enc:${SESSION}`);
    assert.ok(!readFileSync(r.file, "utf8").includes(SESSION), "the session is never stored in the clear");
    assert.equal((await statusOf(r, "acct_a")).name, "Sam Rao");
    assert.ok(r.clients[0].destroyed, "the sign-in connection is closed");
  } finally {
    r.done();
  }
});

test("sign-in with two-step verification: the hint, a wrong password, the right one", async () => {
  const r = rig();
  try {
    r.server.password = "hunter2";
    await r.tg.login({ phone: "+447700900123" }, "acct_a");
    assert.deepEqual(await r.tg.login({ code: "12345" }, "acct_a"), { step: "password", hint: "pet" });
    assert.equal((await statusOf(r, "acct_a")).hint, "pet");
    assert.deepEqual(await r.tg.login({ password: "nope" }, "acct_a"), { error: "wrong_password" });
    assert.equal((await statusOf(r, "acct_a")).step, "password");
    assert.deepEqual(await r.tg.login({ password: "hunter2" }, "acct_a"), { step: "done" });
    assert.equal((await statusOf(r, "acct_a")).step, "signed_in");
  } finally {
    r.done();
  }
});

test("sign-in errors: FLOOD_WAIT on the code, a stale code, cancel, no keychain", async () => {
  const r = rig();
  try {
    r.server.sendCodeError = flood(300);
    assert.deepEqual(await r.tg.login({ phone: "+447700900123" }, "acct_a"), { error: "flood_wait", waitSeconds: 300 });
    r.server.sendCodeError = null;
    assert.deepEqual(await r.tg.login({ code: "12345" }, "acct_a"), { error: "code_expired" });
    await r.tg.login({ phone: "+447700900123" }, "acct_a");
    // Another Work account cannot finish this one's sign-in.
    assert.deepEqual(await r.tg.login({ code: "12345" }, "acct_b"), { error: "code_expired" });
    await r.tg.login({ phone: "+447700900123" }, "acct_a");
    r.clock.now += 16 * 60_000;
    assert.deepEqual(await r.tg.login({ code: "12345" }, "acct_a"), { error: "code_expired" });
    await r.tg.login({ phone: "+447700900123" }, "acct_a");
    assert.deepEqual(await r.tg.login({ cancel: true }, "acct_a"), { step: "signed_out" });
    assert.ok(r.clients.every((c) => c.destroyed), "no sign-in connection is left open");
    const locked = createTelegram({ credentials: CREDENTIALS, file: r.file, storage: async () => null });
    assert.deepEqual(await locked.login({ phone: "+447700900123" }, "acct_a"), { error: "no_keyring" });
    assert.deepEqual(await createTelegram({ credentials: null, file: r.file, storage: async () => null }).status("acct_a"), { available: false });
  } finally {
    r.done();
  }
});

/** Ann (private, two days), Ops (a supergroup), News (a channel), Old group (a basic group), the service chat. */
function seed(server) {
  server.add(ann, { id: 1, date: NOW / 1000 - 100 * DAY, message: "too old" });
  server.add(ann, { id: 10, date: at("2026-11-19T23:30:00Z"), message: "Can we ship on Friday?" });
  server.add(ann, { id: 11, date: at("2026-11-20T08:00:00Z"), message: "Yes", out: true });
  server.add(ann, { id: 12, date: at("2026-11-20T08:05:00Z"), message: "the invoice", media: new Api.MessageMediaDocument({ document: new Api.Document({ id: big(1), accessHash: big(1), fileReference: Buffer.alloc(0), date: 0, mimeType: "application/pdf", size: big(10), dcId: 2, attributes: [new Api.DocumentAttributeFilename({ fileName: "invoice.pdf" })] }) }) });
  server.add(group, { id: 5, date: at("2026-11-20T09:00:00Z"), message: "standup?", fromId: new Api.PeerUser({ userId: bob.id }) });
  server.add(group, { id: 6, date: at("2026-11-20T09:01:00Z"), message: "", media: new Api.MessageMediaPhoto({}), fromId: new Api.PeerUser({ userId: ann.id }) });
  server.chats.get(group).push(new Api.MessageService({ id: 7, peerId: peerOf(group), date: at("2026-11-20T09:02:00Z"), action: new Api.MessageActionChatJoinedByLink({ inviterId: big(1) }) }));
  server.add(news, { id: 3, date: at("2026-11-20T07:00:00Z"), message: "release notes" });
  server.add(basic, { id: 20, date: at("2026-11-18T12:00:00Z"), message: "lunch", fromId: new Api.PeerUser({ userId: bob.id }) });
  server.add(service, { id: 30, date: at("2026-11-20T09:30:00Z"), message: "Login code: 12345" });
}

test("first read: private chats and groups by the export's bare ids and UTC days; channels and the service chat left out", async () => {
  const r = rig();
  try {
    await signIn(r);
    seed(r.server);
    const read = await r.tg.read(undefined, "acct_a");
    const byKey = Object.fromEntries(read.records.map((rec) => [`${rec.chat_id}:${rec.day}`, rec]));
    assert.deepEqual(Object.keys(byKey).sort(), ["123:2026-11-20", "55:2026-11-18", "777:2026-11-19", "777:2026-11-20"]);
    assert.deepEqual(byKey["777:2026-11-20"], {
      chat_id: "777",
      chat_name: "Ann Buyer",
      day: "2026-11-20",
      messages: [
        { id: 11, date: at("2026-11-20T08:00:00Z"), text: "Yes", from: "Sam Rao" },
        { id: 12, date: at("2026-11-20T08:05:00Z"), text: "the invoice", from: "Ann Buyer", file_name: "invoice.pdf" },
      ],
    });
    assert.deepEqual(byKey["123:2026-11-20"].messages, [
      { id: 5, date: at("2026-11-20T09:00:00Z"), text: "standup?", from: "Bob" },
      { id: 6, date: at("2026-11-20T09:01:00Z"), text: "", from: "Ann Buyer", photo: true },
    ]);
    assert.equal(byKey["55:2026-11-18"].chat_name, "Old group");
    assert.ok(!JSON.stringify(read.records).includes("too old"), "the first read goes back 90 days");
    assert.ok(!JSON.stringify(read.records).includes("Login code"), "the service chat is never read");
    assert.ok(!JSON.stringify(read.records).includes("release notes"), "channels only with the setting");
    assert.equal(read.messageCount, 6);
    assert.deepEqual(read.cursor, { user: "42", channels: false, at: NOW / 1000, chats: { 777: 12, 123: 7, 55: 20 } });
    // Paced: no two requests closer than GAP_MS.
    assert.ok(r.clock.sleeps.every((ms) => ms <= GAP_MS) && r.clock.sleeps.length >= 3);
    assert.ok(r.clients.at(-1).destroyed);
    assert.equal(r.clients.at(-1).opened, SESSION, "the read uses the decrypted login");

    await r.tg.setSettings({ channels: true, days: 30 }, "acct_a");
    const withChannels = await r.tg.read(read.cursor, "acct_a");
    assert.deepEqual(withChannels.records.map((rec) => `${rec.chat_id}:${rec.day}`), ["456:2026-11-20"]);
  } finally {
    r.done();
  }
});

test("incremental: only chats past their last id are read, and a new message's whole day is sent again", async () => {
  const r = rig();
  try {
    await signIn(r);
    seed(r.server);
    const first = await r.tg.read(undefined, "acct_a");
    r.clock.now += 10 * 60_000;
    r.server.calls.length = 0;
    r.server.add(ann, { id: 13, date: at("2026-11-20T10:05:00Z"), message: "Friday works" });
    const next = await r.tg.read(first.cursor, "acct_a");
    assert.deepEqual(r.server.calls.filter((c) => c.startsWith("history")), ["history 777 from 0"]);
    assert.equal(next.messageCount, 1);
    assert.deepEqual(next.records.map((rec) => [rec.chat_id, rec.day, rec.messages.map((m) => m.id)]), [["777", "2026-11-20", [11, 12, 13]]]);
    assert.equal(next.cursor.chats[777], 13);
    // Nothing new: the dialogs are listed and no chat is read.
    r.server.calls.length = 0;
    const idle = await r.tg.read(next.cursor, "acct_a");
    assert.deepEqual(idle.records, []);
    assert.deepEqual(r.server.calls, ["messages.GetDialogs"]);
    // Another Telegram account signed in later starts over.
    const other = await r.tg.read({ ...next.cursor, user: "99" }, "acct_a");
    assert.equal(other.records.length, 4);
  } finally {
    r.done();
  }
});

test("FLOOD_WAIT: a short one is waited out; a long one ends the run with what was read", async () => {
  const r = rig();
  try {
    await signIn(r);
    seed(r.server);
    r.server.errors.push(null, flood(5));
    const waited = await r.tg.read(undefined, "acct_a");
    assert.ok(r.clock.sleeps.includes(6000), "waits the seconds Telegram asked, plus one");
    assert.equal(waited.records.length, 4);
    assert.equal(waited.retryAfterMs, undefined);

    r.clock.sleeps.length = 0;
    // The listing and the first chat go through; the second is told to wait an hour.
    r.server.errors.push(null, null, flood(3600));
    const cut = await r.tg.read(undefined, "acct_a");
    assert.equal(cut.retryAfterMs, 3601 * 1000);
    assert.ok(!r.clock.sleeps.some((ms) => ms > GAP_MS), "a long wait is not slept through");
    // Ops (newest) was read; Ann was told to wait.
    assert.deepEqual(Object.keys(cut.cursor.chats), ["123"], "only the chat read to its end moves on");
    assert.ok(cut.records.length && cut.records.every((rec) => rec.chat_id === "123"));
    assert.equal(cut.cursor.at, null, "an unfinished run keeps the previous floor");
  } finally {
    r.done();
  }
});

test("a chat Telegram refuses is skipped and tried again next run; the others are read", async () => {
  const r = rig();
  try {
    await signIn(r);
    seed(r.server);
    // The listing goes through; Ops (read first) is refused.
    r.server.errors.push(null, new errors.RPCError("CHANNEL_PRIVATE", null, 400));
    const read = await r.tg.read(undefined, "acct_a");
    assert.deepEqual(Object.keys(read.cursor.chats).sort(), ["55", "777"]);
    assert.ok(!read.records.some((rec) => rec.chat_id === "123"));
    const next = await r.tg.read(read.cursor, "acct_a");
    assert.deepEqual(next.records.map((rec) => rec.chat_id), ["123"]);
  } finally {
    r.done();
  }
});

test("account switch: the login belongs to the Work account it was made in", async () => {
  const r = rig();
  try {
    await signIn(r, "acct_a");
    seed(r.server);
    await assert.rejects(r.tg.read(undefined, "acct_b"), { code: "other_account" });
    assert.deepEqual(await statusOf(r, "acct_b"), { available: true, step: "other_account", name: null, via: null, hint: null, channels: false, days: 90 });
    // The Work account not known yet (offline at start): the card is hidden, never "another account" with a Disconnect.
    assert.deepEqual(await statusOf(r, null), { available: false });
    assert.equal((await statusOf(r, "acct_a")).step, "signed_in");
    await r.tg.setSettings({ channels: true }, "acct_b");
    assert.equal(JSON.parse(readFileSync(r.file, "utf8")).channels, false, "another account cannot change its settings");
    assert.equal(r.server.calls.filter((c) => c === "messages.GetDialogs").length, 0, "nothing was read for the other account");
  } finally {
    r.done();
  }
});

test("Disconnect logs out on Telegram and deletes the local login, also when offline", async () => {
  const r = rig();
  try {
    await signIn(r);
    await r.tg.logout();
    assert.equal(r.server.loggedOut, 1);
    assert.equal(existsSync(r.file), false);
    assert.equal((await statusOf(r, "acct_a")).step, "signed_out");
    await assert.rejects(r.tg.read(undefined, "acct_a"), { code: "signed_out" });

    await signIn(r);
    r.server.errors.push(new Error("offline"));
    await r.tg.logout();
    assert.equal(existsSync(r.file), false);
  } finally {
    r.done();
  }
});

test("offline: sign-in and reads stop at once instead of waiting on Telegram", async () => {
  const r = rig();
  try {
    r.server.offline = true;
    assert.deepEqual(await r.tg.login({ phone: "+447700900123" }, "acct_a"), { error: "offline" });
    r.server.offline = false;
    await signIn(r);
    r.server.offline = true;
    await assert.rejects(r.tg.read(undefined, "acct_a"), { code: "offline" });
    assert.ok(existsSync(r.file), "an offline read keeps the login");
    assert.ok(r.clients.every((c) => c.destroyed), "no client is left open");
  } finally {
    r.done();
  }
});

test("a login Telegram ended elsewhere is removed here", async () => {
  const r = rig();
  try {
    await signIn(r);
    r.server.errors.push(new errors.RPCError("AUTH_KEY_UNREGISTERED", null, 401));
    await assert.rejects(r.tg.read(undefined, "acct_a"), { code: "signed_out" });
    assert.equal(existsSync(r.file), false);
  } finally {
    r.done();
  }
});

test("message rows: captions with file names, voice and stickers, other media by kind; service lines dropped", () => {
  const doc = (attributes, mimeType = "audio/ogg") => new Api.MessageMediaDocument({ document: new Api.Document({ id: big(1), accessHash: big(1), fileReference: Buffer.alloc(0), date: 0, mimeType, size: big(1), dcId: 1, attributes }) });
  const msg = (media, message = "") => new Api.Message({ id: 1, date: 100, message, media, peerId: new Api.PeerUser({ userId: big(1) }) });
  assert.deepEqual(messageRow(msg(doc([new Api.DocumentAttributeAudio({ duration: 3, voice: true })])), "Ann"), { id: 1, date: 100, text: "", from: "Ann", media_type: "voice_message" });
  assert.equal(messageRow(msg(doc([new Api.DocumentAttributeSticker({ alt: "x", stickerset: new Api.InputStickerSetEmpty() }), new Api.DocumentAttributeFilename({ fileName: "sticker.webp" })], "image/webp")), "Ann").media_type, "sticker");
  assert.equal(messageRow(msg(new Api.MessageMediaGeo({ geo: new Api.GeoPointEmpty() })), "").media_type, "geo");
  assert.equal(messageRow(msg(new Api.MessageMediaWebPage({ webpage: new Api.WebPageEmpty({ id: big(1) }) }), "see https://x.test"), "").media_type, undefined);
  assert.equal(messageRow(new Api.MessageService({ id: 2, date: 100, peerId: new Api.PeerUser({ userId: big(1) }), action: new Api.MessageActionHistoryClear() }), "x"), null);
});

test("credentials: both values from the build file, or the feature stays hidden", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "work-telegram-cred-"));
  try {
    const file = path.join(dir, "omnirush-telegram.json");
    assert.equal(telegramCredentials(file), null);
    writeFileSync(file, "{}");
    assert.equal(telegramCredentials(file), null);
    writeFileSync(file, JSON.stringify({ apiId: 12345, apiHash: "not-a-hash" }));
    assert.equal(telegramCredentials(file), null);
    writeFileSync(file, JSON.stringify(CREDENTIALS));
    assert.deepEqual(telegramCredentials(file), CREDENTIALS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
