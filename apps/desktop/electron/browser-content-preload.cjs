const electron = require("electron");
const contextBridge = electron && typeof electron === "object" ? electron.contextBridge : null;
const ipcRenderer = electron && typeof electron === "object" ? electron.ipcRenderer : null;
const webFrame = electron && typeof electron === "object" ? electron.webFrame : null;

// This function is serialized into the website's main JavaScript world. Keep it
// self-contained: it must never close over Electron, Node, or OmniRush.ai objects.
function installWebMcpRuntime() {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  if (!globalThis.isSecureContext) return false;
  if ("modelContext" in Document.prototype && document.modelContext) {
    if (typeof document.modelContext.addEventListener === "function") {
      document.modelContext.addEventListener("toolchange", () => {
        window.dispatchEvent(new Event("omnirush:webmcp-tools-changed"));
      });
    }
    return false;
  }

  const INTERNAL = Symbol.for("webmcp.model-context.internal");
  const POLICY_BRIDGE = "__omnirushWebMcpPolicyV1";
  const contexts = new WeakMap();
  const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

  function domError(message, name) {
    return new DOMException(message, name);
  }

  function abortReason(signal) {
    return signal?.reason ?? domError("The operation was aborted.", "AbortError");
  }

  async function assertPolicy(targetWindow = window) {
    const check = targetWindow?.[POLICY_BRIDGE]?.check;
    if (typeof check !== "function") return;
    const policy = await check();
    if (!policy?.originKeyed) {
      throw domError("WebMCP requires an origin-keyed document.", "SecurityError");
    }
    if (!policy?.allowed) {
      throw domError("WebMCP is disabled by the tools Permissions Policy.", "NotAllowedError");
    }
  }

  function serializeJson(value, label) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError(`${label} is not JSON serializable.`);
    return serialized;
  }

  function potentiallyTrustworthy(url) {
    if (url.protocol === "https:" || url.protocol === "wss:" || url.protocol === "file:") return true;
    if (url.protocol !== "http:" && url.protocol !== "ws:") return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  }

  function parseOrigins(values, label) {
    if (values === undefined) return [];
    if (!Array.isArray(values)) throw new TypeError(`${label} must be a sequence of origins.`);
    return values.map((value) => {
      let parsed;
      try {
        parsed = new URL(String(value));
      } catch {
        throw domError(`${label} contains an invalid origin.`, "SecurityError");
      }
      if (!potentiallyTrustworthy(parsed) || parsed.origin === "null") {
        throw domError(`${label} contains an origin that is not potentially trustworthy.`, "SecurityError");
      }
      return parsed.origin;
    });
  }

  function sameOriginDocument(candidate, expectedOrigin) {
    try {
      return candidate?.location?.origin === expectedOrigin ? candidate.document : null;
    } catch {
      return null;
    }
  }

  function sameOriginDescendants(ownerDocument) {
    const ownerWindow = ownerDocument.defaultView;
    if (!ownerWindow) return [];
    const origin = ownerWindow.location.origin;
    const result = [];
    const visit = (candidateWindow) => {
      const candidateDocument = sameOriginDocument(candidateWindow, origin);
      if (!candidateDocument) return;
      result.push({ document: candidateDocument, window: candidateWindow, origin });
      for (let index = 0; index < candidateWindow.frames.length; index += 1) {
        visit(candidateWindow.frames[index]);
      }
    };
    visit(ownerWindow);
    return result;
  }

  function notifyToolChange(ownerDocument, exposedOrigins) {
    const ownerWindow = ownerDocument.defaultView;
    if (!ownerWindow) return Promise.resolve();
    return new Promise((resolve) => {
      setTimeout(() => {
        // Do not inspect child contentWindow/contentDocument while a frame is
        // loading. Electron can suppress that frame's preload when it is
        // accessed this early, which would prevent the WebMCP runtime itself
        // from being installed there. Every frame relays its own registrations
        // to the native browser host, so browser-agent discovery remains live.
        ownerDocument.modelContext?.dispatchEvent(new Event("toolchange"));
        // A DOM event is the preload's only signal to refresh native discovery.
        // It contains no data and grants the page no Electron capability.
        ownerWindow.dispatchEvent(new Event("omnirush:webmcp-tools-changed"));
        resolve();
      }, 0);
    });
  }

  class ModelContext extends EventTarget {
    constructor(ownerDocument) {
      super();
      Object.defineProperty(this, INTERNAL, {
        value: { ownerDocument, tools: new Map(), ontoolchange: null },
      });
    }

    get ontoolchange() {
      return this[INTERNAL].ontoolchange;
    }

    set ontoolchange(handler) {
      const state = this[INTERNAL];
      if (state.ontoolchange) this.removeEventListener("toolchange", state.ontoolchange);
      state.ontoolchange = typeof handler === "function" ? handler : null;
      if (state.ontoolchange) this.addEventListener("toolchange", state.ontoolchange);
    }

    async registerTool(tool, options = {}) {
      const state = this[INTERNAL];
      if (!state.ownerDocument.defaultView || !state.ownerDocument.defaultView.document) {
        throw domError("The document is not fully active.", "InvalidStateError");
      }
      await assertPolicy(state.ownerDocument.defaultView);
      if (!tool || typeof tool !== "object") throw new TypeError("A WebMCP tool dictionary is required.");
      const name = String(tool.name ?? "");
      const description = String(tool.description ?? "");
      const title = tool.title === undefined ? "" : String(tool.title);
      if (!TOOL_NAME.test(name) || !description) {
        throw domError("The WebMCP tool name or description is invalid.", "InvalidStateError");
      }
      if (typeof tool.execute !== "function") throw new TypeError("The WebMCP tool execute callback is required.");
      if (state.tools.has(name)) {
        throw domError(`A WebMCP tool named ${name} is already registered.`, "InvalidStateError");
      }
      const schemaText = tool.inputSchema === undefined
        ? ""
        : serializeJson(tool.inputSchema, "The WebMCP input schema");
      if (tool.inputSchema !== undefined && (!tool.inputSchema || typeof tool.inputSchema !== "object")) {
        throw new TypeError("The WebMCP input schema must be an object.");
      }
      const inputSchema = schemaText ? JSON.parse(schemaText) : undefined;
      const signal = options?.signal;
      if (signal?.aborted) throw abortReason(signal);
      const exposedOrigins = parseOrigins(options?.exposedTo, "exposedTo");
      const registration = {
        name,
        title,
        description,
        inputSchema,
        execute: tool.execute,
        annotations: tool.annotations === undefined ? undefined : {
          readOnlyHint: tool.annotations?.readOnlyHint === true,
          untrustedContentHint: tool.annotations?.untrustedContentHint === true,
        },
        exposedOrigins,
        abortListener: null,
      };
      if (signal) {
        registration.abortListener = () => {
          if (state.tools.get(name) !== registration) return;
          state.tools.delete(name);
          void notifyToolChange(state.ownerDocument, registration.exposedOrigins);
        };
        signal.addEventListener("abort", registration.abortListener, { once: true });
      }
      state.tools.set(name, registration);
      await notifyToolChange(state.ownerDocument, exposedOrigins);
      if (signal?.aborted) {
        if (state.tools.get(name) === registration) state.tools.delete(name);
        throw abortReason(signal);
      }
    }

    async getTools(options = {}) {
      const state = this[INTERNAL];
      const ownerWindow = state.ownerDocument.defaultView;
      if (!ownerWindow) throw domError("The document is not fully active.", "InvalidStateError");
      await assertPolicy(ownerWindow);
      const callerOrigin = ownerWindow.location.origin;
      const requestedOrigins = parseOrigins(options?.fromOrigins, "fromOrigins");
      const tools = [];
      for (const target of sameOriginDescendants(state.ownerDocument)) {
        if (target.origin !== callerOrigin && !requestedOrigins.includes(target.origin)) continue;
        const targetContext = target.document.modelContext;
        const targetState = targetContext?.[INTERNAL];
        if (!targetState) continue;
        for (const registration of targetState.tools.values()) {
          if (target.origin !== callerOrigin && !registration.exposedOrigins.includes(callerOrigin)) continue;
          tools.push({
            name: registration.name,
            title: registration.title,
            description: registration.description,
            ...(registration.inputSchema !== undefined
              ? { inputSchema: JSON.parse(JSON.stringify(registration.inputSchema)) }
              : {}),
            window: target.window,
            origin: target.origin,
            ...(registration.annotations ? { annotations: { ...registration.annotations } } : {}),
          });
        }
      }
      tools.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return tools;
    }

    async executeTool(tool, inputObject = {}, options = {}) {
      const state = this[INTERNAL];
      if (!state.ownerDocument.defaultView) {
        throw domError("The document is not fully active.", "InvalidStateError");
      }
      await assertPolicy(state.ownerDocument.defaultView);
      if (!tool || typeof tool !== "object") throw new TypeError("A registered WebMCP tool is required.");
      if (!inputObject || typeof inputObject !== "object") {
        throw domError("WebMCP tool input must be an object.", "DataError");
      }
      const targetWindow = tool.window;
      let targetDocument;
      try {
        targetDocument = targetWindow?.document;
      } catch {
        throw domError("The WebMCP tool target is not accessible.", "SecurityError");
      }
      if (!targetDocument) throw domError("The WebMCP tool target no longer exists.", "NotFoundError");
      const targetContext = targetDocument.modelContext;
      const targetState = targetContext?.[INTERNAL];
      const registration = targetState?.tools.get(String(tool.name ?? ""));
      if (!registration || targetWindow.location.origin !== tool.origin) {
        throw domError("The WebMCP tool is no longer registered.", "NotFoundError");
      }
      const input = JSON.parse(serializeJson(inputObject, "WebMCP tool input"));
      const outerSignal = options?.signal;
      if (outerSignal?.aborted) throw abortReason(outerSignal);
      const controller = new AbortController();
      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => outerSignal?.removeEventListener("abort", onAbort);
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback(value);
        };
        const onAbort = () => {
          const reason = abortReason(outerSignal);
          controller.abort(reason);
          finish(reject, reason);
        };
        outerSignal?.addEventListener("abort", onAbort, { once: true });
        Promise.resolve()
          .then(() => registration.execute(input, { signal: controller.signal }))
          .then((value) => {
            let serialized;
            try {
              serialized = serializeJson(value, "The WebMCP tool result");
            } catch (error) {
              finish(reject, error);
              return;
            }
            finish(resolve, serialized);
          })
          .catch(() => finish(reject, domError("The WebMCP tool execution failed.", "UnknownError")));
      });
    }
  }

  Object.defineProperty(Document.prototype, "modelContext", {
    configurable: true,
    enumerable: true,
    get() {
      let context = contexts.get(this);
      if (!context) {
        context = new ModelContext(this);
        contexts.set(this, context);
      }
      return context;
    },
  });
  return true;
}

// Calls and alerts (Work, the person's own tabs). Electron can only tell a page
// "granted" or "denied" when it checks a permission, so a site the person has
// not answered yet would read "denied" and never ask. In the page's world this
// reports "prompt" (and Notification.permission "default") for those, from the
// state the app gives this frame; the app still answers every real request.
// getDisplayMedia also tells the app it is the caller first: Electron hands a
// page that uses the old chromeMediaSource constraint the whole screen with no
// picker, so the app lets a screen request through only right after it.
// Serialized into the page's main world: keep it self-contained.
function installSitePermissionRuntime() {
  const bridge = globalThis.__omnirushSitePermissionsV1;
  if (!bridge || typeof bridge.state !== "function") return false;
  const asking = (name) => {
    try {
      return bridge.state()?.[name] === "ask";
    } catch {
      return false;
    }
  };
  try {
    const Notice = globalThis.Notification;
    const descriptor = Notice ? Object.getOwnPropertyDescriptor(Notice, "permission") : null;
    if (descriptor?.get && descriptor.configurable) {
      const read = descriptor.get;
      Object.defineProperty(Notice, "permission", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: { permission() {
          const value = read.call(this);
          return value === "denied" && asking("notifications") ? "default" : value;
        } }.permission,
      });
    }
  } catch {}
  try {
    const PermissionsApi = globalThis.Permissions;
    const Status = globalThis.PermissionStatus;
    const query = PermissionsApi?.prototype?.query;
    const stateOf = Status ? Object.getOwnPropertyDescriptor(Status.prototype, "state")?.get : null;
    const names = { camera: "camera", microphone: "microphone", notifications: "notifications" };
    if (typeof query === "function" && stateOf) {
      PermissionsApi.prototype.query = { query(descriptor) {
        const name = descriptor && typeof descriptor === "object" && Object.prototype.hasOwnProperty.call(names, descriptor.name) ? names[descriptor.name] : undefined;
        return query.call(this, descriptor).then((status) => {
          if (name && status && typeof status === "object") {
            Object.defineProperty(status, "state", {
              configurable: true,
              enumerable: true,
              get() {
                const value = stateOf.call(this);
                return value === "denied" && asking(name) ? "prompt" : value;
              },
            });
          }
          return status;
        });
      } }.query;
    }
  } catch {}
  try {
    const Devices = globalThis.MediaDevices;
    const display = Devices?.prototype?.getDisplayMedia;
    if (typeof display === "function") {
      Devices.prototype.getDisplayMedia = { getDisplayMedia(...args) {
        let intent;
        try {
          intent = Promise.resolve(bridge.screenIntent?.());
        } catch {
          intent = Promise.resolve();
        }
        return intent.catch(() => undefined).then(() => display.apply(this, args));
      } }.getDisplayMedia;
    }
  } catch {}
  return true;
}

/**
 * The isolated half: this frame's state from the app, kept fresh, and the getDisplayMedia notice. Only in the
 * person's own tabs with Work's calls and alerts on (the app passes --omnirush-site-prompts); every other page,
 * an agent's tab included, keeps the browser exactly as it was.
 */
function installSitePermissionBridge() {
  if (typeof contextBridge?.exposeInMainWorld !== "function" || !ipcRenderer?.invoke) return;
  const argv = typeof process !== "undefined" && Array.isArray(process.argv) ? process.argv : [];
  if (!argv.includes("--omnirush-site-prompts")) return;
  let protocol = "";
  try {
    protocol = String(location.protocol);
  } catch {}
  if (protocol !== "https:" && protocol !== "http:") return;
  let state = null;
  const pick = (value) => (value === "ask" || value === "allow" || value === "block" ? value : "block");
  const refresh = () => ipcRenderer.invoke("omnirush:browser:site-permission-state").then((value) => {
    state = value && typeof value === "object"
      ? { camera: pick(value.camera), microphone: pick(value.microphone), notifications: pick(value.notifications) }
      : null;
  }, () => { state = null; });
  void refresh();
  ipcRenderer.on?.("omnirush:browser:site-permissions-changed", () => { void refresh(); });
  contextBridge.exposeInMainWorld("__omnirushSitePermissionsV1", {
    state: () => (state ? { ...state } : null),
    screenIntent: () => ipcRenderer.invoke("omnirush:browser:screen-intent").then(() => undefined, () => undefined),
  });
  if (typeof contextBridge.executeInMainWorld === "function") {
    contextBridge.executeInMainWorld({ func: installSitePermissionRuntime });
  } else if (typeof webFrame?.executeJavaScript === "function") {
    void webFrame.executeJavaScript(`(${installSitePermissionRuntime.toString()})()`);
  }
}

function dismissMenuOverlay() {
  ipcRenderer?.send("omnirush:menu-overlay:dismiss");
}

function installDismissListeners() {
  window.addEventListener("pointerdown", dismissMenuOverlay, { capture: true });
  window.addEventListener("wheel", dismissMenuOverlay, { capture: true, passive: true });
  window.addEventListener("keydown", dismissMenuOverlay, { capture: true });
}

function installToolChangeRelay() {
  let timer = null;
  window.addEventListener("omnirush:webmcp-tools-changed", () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      ipcRenderer?.send("omnirush:webmcp:tools-changed");
    }, 250);
  });
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  // This listener and its DOM wrappers live only in Electron's isolated world.
  // Main-world overrides cannot alter these reads or send IPC replies. The only
  // page-facing method below requests a check; it never forwards caller data.
  ipcRenderer?.on("omnirush:webmcp:read-policy", (_event, replyChannel, childIndex) => {
    let policy = null;
    try {
      let embedding = null;
      if (Number.isInteger(childIndex) && childIndex >= 0) {
        const childWindow = window.frames[childIndex];
        const element = Array.from(document.querySelectorAll("iframe,frame"))
          .find((candidate) => candidate.contentWindow === childWindow);
        if (element) {
          let sourceOrigin = null;
          try { sourceOrigin = new URL(element.src, document.baseURI).origin; } catch {}
          embedding = {
            allow: element.getAttribute("allow") || "",
            sourceOrigin,
          };
        }
      }
      policy = {
        originAgentCluster: window.originAgentCluster === true,
        domainMatchesHost: document.domain === location.hostname,
        embedding,
      };
    } catch {}
    ipcRenderer.send(replyChannel, policy);
  });
  try {
    if (typeof contextBridge?.exposeInMainWorld === "function" && ipcRenderer?.invoke) {
      contextBridge.exposeInMainWorld("__omnirushWebMcpPolicyV1", {
        check: () => ipcRenderer.invoke("omnirush:webmcp:frame-policy"),
      });
    }
    if (typeof contextBridge?.executeInMainWorld === "function") {
      contextBridge.executeInMainWorld({ func: installWebMcpRuntime });
    } else if (typeof webFrame?.executeJavaScript === "function") {
      void webFrame.executeJavaScript(`(${installWebMcpRuntime.toString()})()`);
    }
  } catch (error) {
    console.warn("[browser] could not install the WebMCP compatibility runtime", error);
  }
  try {
    installSitePermissionBridge();
  } catch (error) {
    console.warn("[browser] could not install the site permission helper", error);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installDismissListeners, { once: true });
  } else {
    installDismissListeners();
  }
  installToolChangeRelay();
}

if (typeof module !== "undefined") module.exports = { installWebMcpRuntime, installSitePermissionRuntime };
