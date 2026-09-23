import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLinuxPasswordStore,
  chromiumPicksBasicText,
  listSessionBusNames,
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
  const calls = [];
  const listBusNames = async (options) => {
    calls.push(options);
    return new Set(["org.freedesktop.DBus", ":1.0", ...names]);
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
  ]) {
    assert.equal(chromiumPicksBasicText(env), false, JSON.stringify(env));
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
  assert.equal(names.has("org.freedesktop.secrets"), true);
  assert.equal(runs[0].file, "dbus-send");
  assert.ok(runs[0].options.timeout <= 300);
  assert.equal(runs[0].options.env.DBUS_SESSION_BUS_ADDRESS, HYPRLAND.DBUS_SESSION_BUS_ADDRESS);

  const tried = [];
  const busctlOnly = async (file) => {
    tried.push(file);
    if (file === "dbus-send") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { stdout: 'as 3 "org.freedesktop.DBus" ":1.4" "org.kde.kwalletd6"\n' };
  };
  const fromBusctl = await listSessionBusNames({ env: HYPRLAND, timeoutMs: 300, runCommand: busctlOnly });
  assert.deepEqual(tried, ["dbus-send", "busctl"]);
  assert.equal(fromBusctl.has("org.kde.kwalletd6"), true);

  let ran = false;
  const noBus = await listSessionBusNames({
    env: { XDG_RUNTIME_DIR: "/nonexistent-omnirush-runtime-dir" },
    timeoutMs: 300,
    runCommand: async () => { ran = true; return { stdout: "" }; },
  });
  assert.equal(noBus, null);
  assert.equal(ran, false);
});
