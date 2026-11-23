const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { runInNewContext } = require("node:vm");

const { installWebMcpRuntime } = require("./browser-content-preload.cjs");

function createRealm(policy = null) {
  class TestDocument {
    constructor() {
      this.defaultView = null;
    }
  }
  class TestWindow extends EventTarget {
    constructor(origin) {
      super();
      this.location = { origin };
      this.frames = [];
      this.document = new TestDocument();
      this.document.defaultView = this;
    }
  }

  const previous = {
    Document: globalThis.Document,
    document: globalThis.document,
    isSecureContext: globalThis.isSecureContext,
    window: globalThis.window,
  };
  const window = new TestWindow("https://example.test");
  if (policy) window.__omnirushWebMcpPolicyV1 = { check: async (...args) => {
    assert.deepEqual(args, []);
    return policy;
  } };
  globalThis.Document = TestDocument;
  globalThis.document = window.document;
  globalThis.window = window;
  globalThis.isSecureContext = true;
  assert.equal(installWebMcpRuntime(), true);

  return {
    window,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

test("imperative WebMCP registration, discovery, execution, and abort unregistration", async () => {
  const realm = createRealm();
  try {
    const registration = new AbortController();
    let observedInput = null;
    let toolChanges = 0;
    realm.window.document.modelContext.ontoolchange = () => { toolChanges += 1; };

    await realm.window.document.modelContext.registerTool({
      name: "read_profile",
      title: "Read profile",
      description: "Read the current signed-in profile.",
      inputSchema: {
        type: "object",
        properties: { detail: { type: "string" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      async execute(input, { signal }) {
        assert.equal(signal.aborted, false);
        observedInput = input;
        return { user: "Jalil", detail: input.detail };
      },
    }, { signal: registration.signal });

    const [tool] = await realm.window.document.modelContext.getTools();
    assert.equal(tool.name, "read_profile");
    assert.equal(tool.window, realm.window);
    assert.equal(tool.origin, "https://example.test");
    assert.deepEqual(tool.annotations, { readOnlyHint: true, untrustedContentHint: true });
    assert.equal(
      await realm.window.document.modelContext.executeTool(tool, { detail: "full" }),
      JSON.stringify({ user: "Jalil", detail: "full" }),
    );
    assert.deepEqual(observedInput, { detail: "full" });
    assert.ok(toolChanges >= 1);

    registration.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(await realm.window.document.modelContext.getTools(), []);
  } finally {
    realm.restore();
  }
});

test("registration rejects duplicate, malformed, and already-aborted tools", async () => {
  const realm = createRealm();
  try {
    const tool = {
      name: "lookup",
      description: "Look up a record.",
      execute: async () => ({}),
    };
    await realm.window.document.modelContext.registerTool(tool);
    await assert.rejects(
      realm.window.document.modelContext.registerTool(tool),
      (error) => error instanceof DOMException && error.name === "InvalidStateError",
    );
    await assert.rejects(
      realm.window.document.modelContext.registerTool({ ...tool, name: "not allowed!" }),
      (error) => error instanceof DOMException && error.name === "InvalidStateError",
    );
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      realm.window.document.modelContext.registerTool({ ...tool, name: "other" }, { signal: aborted.signal }),
      (error) => error?.name === "AbortError",
    );
  } finally {
    realm.restore();
  }
});

test("executeTool propagates cancellation to the website callback", async () => {
  const realm = createRealm();
  try {
    let callbackSignal;
    await realm.window.document.modelContext.registerTool({
      name: "wait",
      description: "Wait until canceled.",
      async execute(_input, { signal }) {
        callbackSignal = signal;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { canceled: signal.aborted };
      },
    });
    const [tool] = await realm.window.document.modelContext.getTools();
    const controller = new AbortController();
    const execution = realm.window.document.modelContext.executeTool(tool, {}, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await assert.rejects(execution, (error) => error?.name === "AbortError");
    assert.equal(callbackSignal.aborted, true);
  } finally {
    realm.restore();
  }
});

test("the page API enforces native frame policy before registering tools", async () => {
  const denied = createRealm({ allowed: false, originKeyed: true });
  try {
    await assert.rejects(
      denied.window.document.modelContext.registerTool({
        name: "blocked",
        description: "Must not register.",
        execute: async () => ({}),
      }),
      (error) => error instanceof DOMException && error.name === "NotAllowedError",
    );
  } finally {
    denied.restore();
  }

  const nonOriginKeyed = createRealm({ allowed: true, originKeyed: false });
  try {
    Object.defineProperty(nonOriginKeyed.window, "originAgentCluster", { get: () => assert.fail("Do not read page-controlled OAC.") });
    Object.defineProperty(nonOriginKeyed.window.document, "domain", { get: () => assert.fail("Do not read page-controlled domain.") });
    await assert.rejects(
      nonOriginKeyed.window.document.modelContext.getTools(),
      (error) => error instanceof DOMException && error.name === "SecurityError",
    );
  } finally {
    nonOriginKeyed.restore();
  }
});

test("the isolated preload exposes only a payload-free check, not a policy-reporting capability", async () => {
  const listeners = new Map();
  const sent = [];
  const invoked = [];
  const exposed = {};
  const child = {};
  const isolatedWindow = { originAgentCluster: false, frames: [child], addEventListener() {} };
  const isolatedDocument = {
    domain: "relaxed.example", baseURI: "https://app.example/", readyState: "loading", addEventListener() {},
    querySelectorAll: () => [
      { contentWindow: {}, src: "https://attacker.example/", getAttribute: () => "tools *" },
      { contentWindow: child, src: "https://child.example/", getAttribute: () => "tools 'src'" },
    ],
  };
  runInNewContext(readFileSync(require.resolve("./browser-content-preload.cjs"), "utf8"), {
    require: () => ({
      ipcRenderer: {
        on: (channel, handler) => listeners.set(channel, handler),
        send: (...args) => sent.push(args),
        invoke: async (...args) => { invoked.push(args); return { originKeyed: false }; },
      },
      contextBridge: {
        exposeInMainWorld: (name, api) => { exposed[name] = api; },
        executeInMainWorld() {},
      },
    }),
    window: isolatedWindow, document: isolatedDocument, location: { hostname: "app.example" }, URL,
  });
  const bridge = exposed.__omnirushWebMcpPolicyV1;
  assert.deepEqual(Object.keys(bridge), ["check"]);
  assert.equal((await bridge.check({ originAgentCluster: true, domainMatchesHost: true })).originKeyed, false);
  assert.deepEqual(invoked, [["omnirush:webmcp:frame-policy"]]);
  const readPolicy = listeners.get("omnirush:webmcp:read-policy");
  readPolicy({}, "native-request", 0);
  assert.equal(sent[0][0], "native-request");
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0][1])), {
    originAgentCluster: false, domainMatchesHost: false,
    embedding: { allow: "tools 'src'", sourceOrigin: "https://child.example" },
  });
  isolatedWindow.originAgentCluster = true;
  isolatedDocument.domain = "app.example";
  readPolicy({}, "fresh-native-request", null);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1][1])), {
    originAgentCluster: true, domainMatchesHost: true, embedding: null,
  });
});

test("aborting while registration is pending rejects and unregisters atomically", async () => {
  const realm = createRealm();
  try {
    const controller = new AbortController();
    const registration = realm.window.document.modelContext.registerTool({
      name: "pending",
      description: "Pending registration.",
      execute: async () => ({}),
    }, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await assert.rejects(registration, (error) => error?.name === "AbortError");
    assert.deepEqual(await realm.window.document.modelContext.getTools(), []);
  } finally {
    realm.restore();
  }
});

// Calls and alerts (Work): the page-world helper.
const { installSitePermissionRuntime } = require("./browser-content-preload.cjs");

function sitePermissionRealm(state, { intent = async () => {} } = {}) {
  const calls = [];
  const realm = {};
  class PermissionStatus {
    constructor(value) { this.value = value; }
    get state() { return this.value; }
  }
  class Permissions {
    query(descriptor) { calls.push(["query", descriptor.name]); return Promise.resolve(new PermissionStatus("denied")); }
  }
  class MediaDevices {
    getDisplayMedia(options) { calls.push(["getDisplayMedia", options]); return Promise.resolve("stream"); }
  }
  class Notification {
    static get permission() { return realm.notificationPermission; }
  }
  realm.notificationPermission = "denied";
  const script = `(${installSitePermissionRuntime.toString()})()`;
  const context = {
    Notification, Permissions, PermissionStatus, MediaDevices,
    __omnirushSitePermissionsV1: {
      state: () => (typeof state === "function" ? state() : state),
      screenIntent: () => { calls.push(["intent"]); return intent(); },
    },
  };
  context.globalThis = context;
  const installed = runInNewContext(script, context);
  return { context, calls, installed, realm };
}

test("a site the person has not answered reads as 'ask', not 'blocked', so it can ask", async () => {
  const { context, installed } = sitePermissionRealm({ camera: "ask", microphone: "allow", notifications: "ask" });
  assert.equal(installed, true);
  assert.equal(context.Notification.permission, "default");
  const permissions = new context.Permissions();
  assert.equal((await permissions.query({ name: "camera" })).state, "prompt");
  assert.equal((await permissions.query({ name: "notifications" })).state, "prompt");
  // Not "ask": the browser's own answer stands (a remembered block, or an allow the browser already reports).
  assert.equal((await permissions.query({ name: "microphone" })).state, "denied");
  assert.equal((await permissions.query({ name: "geolocation" })).state, "denied");
});

test("blocked sites, agents' tabs and accounts without Work keep the browser's own 'denied'", async () => {
  for (const state of [{ camera: "block", microphone: "block", notifications: "block" }, null]) {
    const { context } = sitePermissionRealm(state);
    assert.equal(context.Notification.permission, "denied");
    assert.equal((await new context.Permissions().query({ name: "camera" })).state, "denied");
  }
  const thrower = sitePermissionRealm(() => { throw new Error("bridge gone"); });
  assert.equal(thrower.context.Notification.permission, "denied");
  // No bridge at all: nothing is installed.
  assert.equal(runInNewContext(`(${installSitePermissionRuntime.toString()})()`, { globalThis: {} }), false);
});

test("getDisplayMedia tells the app first, then asks the browser with the page's own arguments", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { context, calls } = sitePermissionRealm({ camera: "ask", microphone: "ask", notifications: "ask" }, { intent: () => gate });
  const devices = new context.MediaDevices();
  const result = devices.getDisplayMedia({ video: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [["intent"]], "the browser is not asked before the app heard");
  release();
  assert.equal(await result, "stream");
  assert.deepEqual(calls, [["intent"], ["getDisplayMedia", { video: true }]]);
  const failing = sitePermissionRealm(null, { intent: () => Promise.reject(new Error("no app")) });
  assert.equal(await new failing.context.MediaDevices().getDisplayMedia({ video: true }), "stream", "a failed notice still lets the browser answer (and refuse)");
});

test("the helper loads only in the person's own tabs with calls and alerts on, and reads only its own frame's state", async () => {
  function load(argv, protocol = "https:") {
    const exposed = {};
    const invoked = [];
    const listeners = new Map();
    const executed = [];
    runInNewContext(readFileSync(require.resolve("./browser-content-preload.cjs"), "utf8"), {
      require: () => ({
        ipcRenderer: {
          on: (channel, handler) => listeners.set(channel, handler),
          send() {},
          invoke: async (...args) => { invoked.push(args); return args[0] === "omnirush:browser:site-permission-state" ? { camera: "ask", microphone: "allow", notifications: "nonsense" } : { originKeyed: false }; },
        },
        contextBridge: {
          exposeInMainWorld: (name, api) => { exposed[name] = api; },
          executeInMainWorld: (script) => executed.push(script.func?.name),
        },
      }),
      process: { argv },
      window: { addEventListener() {}, frames: [] }, document: { readyState: "complete", addEventListener() {} },
      location: { protocol, hostname: "meet.google.com" }, URL,
    });
    return { exposed, invoked, listeners, executed };
  }
  const off = load(["electron"]);
  assert.equal(off.exposed.__omnirushSitePermissionsV1, undefined, "an agent's tab or a consumer's page gets nothing new");
  assert.deepEqual(off.invoked.filter(([channel]) => channel.startsWith("omnirush:browser:")), []);
  assert.deepEqual(off.executed, ["installWebMcpRuntime"]);
  assert.equal(load(["electron", "--omnirush-site-prompts"], "about:").exposed.__omnirushSitePermissionsV1, undefined);

  const on = load(["electron", "--omnirush-site-prompts"]);
  const bridge = on.exposed.__omnirushSitePermissionsV1;
  assert.deepEqual([...Object.keys(bridge)].sort(), ["screenIntent", "state"]);
  assert.deepEqual(on.executed, ["installWebMcpRuntime", "installSitePermissionRuntime"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(on.invoked.filter(([channel]) => channel.startsWith("omnirush:browser:")), [["omnirush:browser:site-permission-state"]], "no page data goes with it");
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.state())), { camera: "ask", microphone: "allow", notifications: "block" }, "an unknown answer reads as blocked");
  await bridge.screenIntent("page data is ignored");
  assert.deepEqual(on.invoked.at(-1), ["omnirush:browser:screen-intent"]);
  assert.ok(on.listeners.has("omnirush:browser:site-permissions-changed"));
});
