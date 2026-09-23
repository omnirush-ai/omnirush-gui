import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyLinuxPasswordStore,
  chromiumPicksBasicText,
  listSessionBusNames,
  recordedLinuxPasswordStore,
  recordLinuxPasswordStore,
  selectLinuxPasswordStore,
} from "./linux-password-store.mjs";

const HYPRLAND = { XDG_CURRENT_DESKTOP: "Hyprland", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };

function fakeApp(argvSwitches = []) {
  const appended = [];
  return {
    appended,
    app: {
      commandLine: {
        hasSwitch: (name) => argvSwitches.includes(name),
        appendSwitch: (name, value) => { appended.push([name, value]); },
      },
    },
  };
}

function busWith(...names) {
  return busWithActivatable(names, []);
}

function busWithActivatable(running, activatable) {
  const calls = [];
  const listBusNames = async (options) => {
    calls.push(options);
    return { running: new Set(["org.freedesktop.DBus", ":1.0", ...running]), activatable: new Set(["org.freedesktop.DBus", ...activatable]) };
  };
  return { calls, listBusNames };
}

test("Chromium's basic_text choice is predicted only for desktops it cannot name", () => {
  for (const desktop of ["Hyprland", "sway", "i3", "niri", "river", ""]) {
    assert.equal(chromiumPicksBasicText({ XDG_CURRENT_DESKTOP: desktop }), true, desktop);
  }
  for (const env of [
    { XDG_CURRENT_DESKTOP: "GNOME" },
    { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
    { XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "6" },
    { XDG_CURRENT_DESKTOP: "XFCE" },
    { XDG_CURRENT_DESKTOP: "X-Cinnamon" },
    { DESKTOP_SESSION: "plasma" },
    { DESKTOP_SESSION: "mate" },
    { KDE_FULL_SESSION: "true" },
    { GNOME_DESKTOP_SESSION_ID: "this-is-deprecated" },
    { DESKTOP_SESSION: "xfce4" },
  ]) {
    assert.equal(chromiumPicksBasicText(env), false, JSON.stringify(env));
  }
  // Chromium maps LXQt, and MATE named only in XDG_CURRENT_DESKTOP, to basic_text.
  for (const env of [{ XDG_CURRENT_DESKTOP: "LXQt" }, { XDG_CURRENT_DESKTOP: "MATE" }, { XDG_CURRENT_DESKTOP: "Hyprland", DESKTOP_SESSION: "hyprland-gnomeish" }]) {
    assert.equal(chromiumPicksBasicText(env), true, JSON.stringify(env));
  }
});

test("a Secret Service provider on the bus selects gnome-libsecret (gnome-keyring, KeePassXC)", async () => {
  const { app, appended } = fakeApp();
  const logs = [];
  const { calls, listBusNames } = busWith("org.freedesktop.secrets");
  const store = await applyLinuxPasswordStore({ app, platform: "linux", env: HYPRLAND, argv: ["omnirush"], listBusNames, log: (line) => logs.push(line) });
  assert.equal(store, "gnome-libsecret");
  assert.deepEqual(appended, [["password-store", "gnome-libsecret"]]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].timeoutMs <= 300);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /gnome-libsecret/);
});

test("KWallet is used when it is the only keyring on the bus", async () => {
  for (const [name, expected] of [["org.kde.kwalletd6", "kwallet6"], ["org.kde.kwalletd5", "kwallet5"]]) {
    const { app, appended } = fakeApp();
    const { listBusNames } = busWith(name);
    await applyLinuxPasswordStore({ app, platform: "linux", env: HYPRLAND, argv: [], listBusNames, log: () => undefined });
    assert.deepEqual(appended, [["password-store", expected]]);
  }
});

test("no keyring on the bus leaves Chromium's choice (the private-file fallback takes over)", async () => {
  const { app, appended } = fakeApp();
  const { listBusNames } = busWith();
  assert.equal(await applyLinuxPasswordStore({ app, platform: "linux", env: HYPRLAND, argv: [], listBusNames, log: () => undefined }), null);
  assert.deepEqual(appended, []);

  const unreachable = await selectLinuxPasswordStore({ platform: "linux", env: HYPRLAND, userChoseStore: false, listBusNames: async () => null });
  assert.deepEqual(unreachable, { store: null, reason: "session bus not reachable" });
  const failing = await selectLinuxPasswordStore({ platform: "linux", env: HYPRLAND, userChoseStore: false, listBusNames: async () => { throw new Error("boom"); } });
  assert.equal(failing.store, null);
});

test("the switch is not appended when the user passed --password-store", async () => {
  for (const [argv, switches] of [[["omnirush", "--password-store=basic"], []], [["omnirush"], ["password-store"]]]) {
    const { app, appended } = fakeApp(switches);
    const { calls, listBusNames } = busWith("org.freedesktop.secrets");
    assert.equal(await applyLinuxPasswordStore({ app, platform: "linux", env: HYPRLAND, argv, listBusNames, log: () => undefined }), null);
    assert.deepEqual(appended, []);
    assert.equal(calls.length, 0);
  }
});

test("desktops Chromium recognizes keep its own choice without a probe", async () => {
  const { app, appended } = fakeApp();
  const { calls, listBusNames } = busWith("org.freedesktop.secrets");
  await applyLinuxPasswordStore({ app, platform: "linux", env: { XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "6" }, argv: [], listBusNames, log: () => undefined });
  assert.deepEqual(appended, []);
  assert.equal(calls.length, 0);
});

test("macOS and Windows never probe or change the password store", async () => {
  for (const platform of /** @type {const} */ (["darwin", "win32"])) {
    const { app, appended } = fakeApp();
    const { calls, listBusNames } = busWith("org.freedesktop.secrets");
    const logs = [];
    assert.equal(await applyLinuxPasswordStore({ app, platform, env: HYPRLAND, argv: [], listBusNames, log: (line) => logs.push(line) }), null);
    assert.deepEqual(appended, []);
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, []);
  }
});

test("listSessionBusNames parses dbus-send, falls back to busctl, and never autolaunches a bus", async () => {
  const runs = [];
  const dbusSend = async (file, args, options) => {
    runs.push({ file, options });
    return { stdout: 'method return time=1 sender=org.freedesktop.DBus\n   array [\n      string "org.freedesktop.DBus"\n      string "org.freedesktop.secrets"\n   ]\n' };
  };
  const names = await listSessionBusNames({ env: HYPRLAND, timeoutMs: 300, runCommand: dbusSend });
  assert.equal(names.running.has("org.freedesktop.secrets"), true);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].file, "dbus-send");
  assert.ok(runs[0].options.timeout <= 300);
  assert.equal(runs[0].options.env.DBUS_SESSION_BUS_ADDRESS, HYPRLAND.DBUS_SESSION_BUS_ADDRESS);

  const tried = [];
  const busctlOnly = async (file, args) => {
    tried.push(`${file} ${args.at(-1)}`);
    if (file === "dbus-send") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return args.at(-1) === "ListNames"
      ? { stdout: 'as 3 "org.freedesktop.DBus" ":1.4" "org.kde.kwalletd6"\n' }
      : { stdout: 'as 2 "org.freedesktop.DBus" "org.freedesktop.secrets"\n' };
  };
  const fromBusctl = await listSessionBusNames({ env: HYPRLAND, timeoutMs: 300, runCommand: busctlOnly });
  assert.deepEqual(tried.sort(), [
    "busctl ListActivatableNames",
    "busctl ListNames",
    "dbus-send org.freedesktop.DBus.ListActivatableNames",
    "dbus-send org.freedesktop.DBus.ListNames",
  ]);
  assert.equal(fromBusctl.running.has("org.kde.kwalletd6"), true);
  assert.equal(fromBusctl.activatable.has("org.freedesktop.secrets"), true);
  assert.equal(fromBusctl.running.has("org.freedesktop.secrets"), false);

  let ran = false;
  const noBus = await listSessionBusNames({
    env: { XDG_RUNTIME_DIR: "/nonexistent-omnirush-runtime-dir" },
    timeoutMs: 300,
    runCommand: async () => { ran = true; return { stdout: "" }; },
  });
  assert.equal(noBus, null);
  assert.equal(ran, false);
});

test("a Secret Service that D-Bus starts on demand but is not running yet selects gnome-libsecret", async () => {
  const { app, appended } = fakeApp();
  const logs = [];
  const { listBusNames } = busWithActivatable([], ["org.freedesktop.secrets", "org.kde.kwalletd6"]);
  const store = await applyLinuxPasswordStore({ app, platform: "linux", env: HYPRLAND, argv: [], listBusNames, log: (line) => logs.push(line) });
  assert.equal(store, "gnome-libsecret");
  assert.deepEqual(appended, [["password-store", "gnome-libsecret"]]);
  assert.match(logs[0], /activatable/);

  // A running keyring wins over one that is only activatable.
  const running = fakeApp();
  await applyLinuxPasswordStore({
    app: running.app, platform: "linux", env: HYPRLAND, argv: [],
    listBusNames: busWithActivatable(["org.kde.kwalletd6"], ["org.freedesktop.secrets"]).listBusNames,
    log: () => undefined,
  });
  assert.deepEqual(running.appended, [["password-store", "kwallet6"]]);
});

test("listSessionBusNames reports activatable names when ListNames fails and stays within the budget", async () => {
  const runs = [];
  const names = await listSessionBusNames({
    env: HYPRLAND,
    timeoutMs: 300,
    runCommand: async (file, args, options) => {
      runs.push({ file, method: args.at(-1), timeout: options.timeout });
      if (args.at(-1).endsWith("ListActivatableNames")) return { stdout: 'array [ string "org.freedesktop.secrets" ]' };
      throw new Error("timed out");
    },
  });
  assert.equal(names.running.size, 0);
  assert.equal(names.activatable.has("org.freedesktop.secrets"), true);
  assert.equal(runs.length, 2);
  assert.ok(runs.every((run) => run.file === "dbus-send" && run.timeout <= 300));
});

test("the store that sealed the sign-in stays chosen on a launch where the probe finds nothing", async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), "omnirush-password-store-"));
  try {
    assert.equal(await recordLinuxPasswordStore({ userDataPath: userData, fileName: "omnirush-account.bin", backend: "gnome_libsecret" }), true);
    assert.equal(await recordLinuxPasswordStore({ userDataPath: userData, fileName: "omnirush-account.bin", backend: "gnome_libsecret" }), false);
    assert.equal(await recordLinuxPasswordStore({ userDataPath: userData, fileName: "omnirush-account.bin", backend: "basic_text" }), false);
    assert.equal((await stat(path.join(userData, "linux-password-store.json"))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path.join(userData, "linux-password-store.json"), "utf8")), { stores: { "omnirush-account.bin": "gnome-libsecret" } });

    // No sealed file: the record alone does not pin the store.
    assert.equal(recordedLinuxPasswordStore(userData), null);
    await writeFile(path.join(userData, "omnirush-account.bin"), "sealed");
    assert.deepEqual(recordedLinuxPasswordStore(userData), { store: "gnome-libsecret", file: "omnirush-account.bin" });

    // The keyring is neither running nor activatable on this launch.
    const nothing = busWith();
    const { app, appended } = fakeApp();
    const logs = [];
    const store = await applyLinuxPasswordStore({ app, platform: "linux", env: HYPRLAND, argv: [], userDataPath: userData, listBusNames: nothing.listBusNames, log: (line) => logs.push(line) });
    assert.equal(store, "gnome-libsecret");
    assert.deepEqual(appended, [["password-store", "gnome-libsecret"]]);
    assert.equal(nothing.calls.length, 0);
    assert.match(logs[0], /omnirush-account\.bin is sealed with it/);

    // It also holds on a desktop Chromium names (a KDE user who signed in from sway).
    const kde = fakeApp();
    await applyLinuxPasswordStore({ app: kde.app, platform: "linux", env: { XDG_CURRENT_DESKTOP: "KDE" }, argv: [], userDataPath: userData, listBusNames: nothing.listBusNames, log: () => undefined });
    assert.deepEqual(kde.appended, [["password-store", "gnome-libsecret"]]);

    // An explicit --password-store still wins, and macOS/Windows never read the record.
    const explicit = fakeApp(["password-store"]);
    assert.equal(await applyLinuxPasswordStore({ app: explicit.app, platform: "linux", env: HYPRLAND, argv: [], userDataPath: userData, listBusNames: nothing.listBusNames, log: () => undefined }), null);
    assert.deepEqual(explicit.appended, []);
    for (const platform of /** @type {const} */ (["darwin", "win32"])) {
      const other = fakeApp();
      assert.equal(await applyLinuxPasswordStore({ app: other.app, platform, env: HYPRLAND, argv: [], userDataPath: userData, readRecorded: () => { throw new Error("read"); }, log: () => undefined }), null);
      assert.deepEqual(other.appended, []);
    }

    // Once the sealed file is gone (signed out) the probe decides again.
    await rm(path.join(userData, "omnirush-account.bin"));
    const after = fakeApp();
    assert.equal(await applyLinuxPasswordStore({ app: after.app, platform: "linux", env: HYPRLAND, argv: [], userDataPath: userData, listBusNames: nothing.listBusNames, log: () => undefined }), null);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});
