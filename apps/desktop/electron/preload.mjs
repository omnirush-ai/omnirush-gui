import { contextBridge, ipcRenderer, webUtils } from "electron";

const NATIVE_DEEP_LINK_EVENT = "omnirush:deep-link-native";
const NATIVE_MENU_OPEN_SETTINGS_EVENT = "omnirush:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "omnirush:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "omnirush:native-menu:check-updates";
const NATIVE_MENU_ZOOM_EVENT = "omnirush:native-menu:zoom";
const AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT = "omnirush:automation-runner:credential-rejected";

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function applyShellDocumentMarkers() {
  try {
    const root = document?.documentElement;
    if (!root) return false;

    root.dataset.omnirushShell = "electron";
    root.classList.add("omnirush-electron");
    if (process.platform === "darwin") {
      root.classList.add("omnirush-platform-mac");
    } else if (process.platform === "win32") {
      root.classList.add("omnirush-platform-windows");
    } else if (process.platform === "linux") {
      root.classList.add("omnirush-platform-linux");
    }
    return true;
  } catch {
    return false;
  }
}

function notifyMenuOverlayDismiss() {
  ipcRenderer.send("omnirush:menu-overlay:dismiss");
}

function installMenuOverlayDismissListeners() {
  try {
    const target = window;
    target.addEventListener("pointerdown", notifyMenuOverlayDismiss, { capture: true });
    target.addEventListener("wheel", notifyMenuOverlayDismiss, { capture: true, passive: true });
    target.addEventListener("keydown", notifyMenuOverlayDismiss, { capture: true });
    return true;
  } catch {
    return false;
  }
}

// Capture before message-bubble menus, but leave files, app routes, editable
// text, and ordinary clicks to their existing handlers.
window.addEventListener("contextmenu", (event) => {
  const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
  if (!anchor || anchor.isContentEditable || anchor.hasAttribute("download")) return;
  const href = anchor.getAttribute("href") ?? "";
  if (!/^(https?:)?\/\//i.test(href)) return;
  let url;
  try { url = new URL(anchor.href); } catch { return; }
  if (!["http:", "https:"].includes(url.protocol)) return;
  if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.send("omnirush:browser:linkContextMenu", {
    url: url.href,
    point: { x: event.clientX, y: event.clientY },
    sessionId: anchor.closest("[data-session-surface-id]")?.getAttribute("data-session-surface-id") ?? null,
  });
}, { capture: true });

let desktopBootstrap = null;
let desktopDistribution = null;
try {
  desktopBootstrap = ipcRenderer.sendSync("omnirush:desktop-bootstrap-sync");
  desktopDistribution = ipcRenderer.sendSync("omnirush:desktop-distribution-sync");
} catch {
  desktopBootstrap = null;
  desktopDistribution = null;
}

contextBridge.exposeInMainWorld("__OMNIRUSH_ELECTRON__", {
  invokeDesktop(command, ...args) {
    return ipcRenderer.invoke("omnirush:desktop", command, ...args);
  },
  automationRunner: {
    onCredentialRejected(callback) {
      const handler = () => callback();
      ipcRenderer.on(AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT, handler);
      return () => ipcRenderer.removeListener(AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT, handler);
    },
  },
  fileSystem: {
    getPathForFile(file) {
      return webUtils.getPathForFile(file);
    },
  },
  shell: {
    openExternal(url) {
      return ipcRenderer.invoke("omnirush:shell:openExternal", url);
    },
    relaunch() {
      return ipcRenderer.invoke("omnirush:shell:relaunch");
    },
  },
  system: {
    getArchitectureInfo() {
      return ipcRenderer.invoke("omnirush:system:architecture");
    },
    getMicrophoneStatus() {
      return ipcRenderer.invoke("omnirush:system:microphoneStatus");
    },
    askMicrophoneAccess() {
      return ipcRenderer.invoke("omnirush:system:askMicrophoneAccess");
    },
  },
  migration: {
    readSnapshot() {
      return ipcRenderer.invoke("omnirush:migration:read");
    },
    ackSnapshot() {
      return ipcRenderer.invoke("omnirush:migration:ack");
    },
  },
  brandIcon: {
    apply(url) {
      return ipcRenderer.invoke("omnirush:desktop", "__applyBrandIcon", url ?? null);
    },
    getState() {
      return ipcRenderer.invoke("omnirush:desktop", "__getBrandIconState");
    },
  },
  dev: {
    evalRelaunch() {
      return ipcRenderer.invoke("omnirush:desktop", "__evalRelaunch");
    },
  },
  nuke: {
    preview(options) {
      return ipcRenderer.invoke("omnirush:desktop", "nukeOmniRushAndOpencodeConfigPreview", options);
    },
    execute(options) {
      return ipcRenderer.invoke("omnirush:desktop", "nukeOmniRushAndOpencodeConfigAndExit", options);
    },
  },
  updater: {
    getChannel() {
      return ipcRenderer.invoke("omnirush:updater:getChannel");
    },
    setChannel(channel) {
      return ipcRenderer.invoke("omnirush:updater:setChannel", channel);
    },
    check(channel, targetVersion) {
      return ipcRenderer.invoke("omnirush:updater:check", channel, targetVersion);
    },
    download() {
      return ipcRenderer.invoke("omnirush:updater:download");
    },
    installAndRestart() {
      return ipcRenderer.invoke("omnirush:updater:installAndRestart");
    },
    /** Subscribe to incremental download progress from electron-updater. */
    onDownloadProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("omnirush:updater:download-progress", handler);
      return () => {
        ipcRenderer.removeListener("omnirush:updater:download-progress", handler);
      };
    },
  },
  recovery: {
    recordHealthy() {
      return ipcRenderer.invoke("omnirush:recovery:recordHealthy");
    },
    list(policy) {
      return ipcRenderer.invoke("omnirush:recovery:list", policy);
    },
    restorePrevious() {
      return ipcRenderer.invoke("omnirush:recovery:restorePrevious");
    },
    use(id) {
      return ipcRenderer.invoke("omnirush:recovery:use", id);
    },
  },
  browser: {
    show(bounds, sessionId) { return ipcRenderer.invoke("omnirush:browser:show", bounds, sessionId); },
    hide() { return ipcRenderer.invoke("omnirush:browser:hide"); },
    openUrl(url, provider, options) { return ipcRenderer.invoke("omnirush:browser:openUrl", url, provider, options); },
    setVisibleSession(sessionId) { return ipcRenderer.invoke("omnirush:browser:setVisibleSession", sessionId); },
    navigate(url) { return ipcRenderer.invoke("omnirush:browser:navigate", url); },
    back() { return ipcRenderer.invoke("omnirush:browser:back"); },
    forward() { return ipcRenderer.invoke("omnirush:browser:forward"); },
    reload() { return ipcRenderer.invoke("omnirush:browser:reload"); },
    setBounds(bounds) { return ipcRenderer.invoke("omnirush:browser:bounds", bounds); },
    getState() { return ipcRenderer.invoke("omnirush:browser:state"); },
    createTab(url, sessionId) { return ipcRenderer.invoke("omnirush:browser:createTab", url, sessionId); },
    closeTab(tabId) { return ipcRenderer.invoke("omnirush:browser:closeTab", tabId); },
    suspendTab(tabId) { return ipcRenderer.invoke("omnirush:browser:suspendTab", tabId); },
    restoreTab(tabId, sessionId) { return ipcRenderer.invoke("omnirush:browser:restoreTab", tabId, sessionId); },
    releaseTab(tabId, sessionId) { return ipcRenderer.invoke("omnirush:browser:releaseTab", tabId, sessionId); },
    closeAllTabs() { return ipcRenderer.invoke("omnirush:browser:closeAllTabs"); },
    closeSessionTabs(sessionId) { return ipcRenderer.invoke("omnirush:browser:closeSessionTabs", sessionId); },
    selectTab(tabId) { return ipcRenderer.invoke("omnirush:browser:selectTab", tabId); },
    reorderTabs(tabIds) { return ipcRenderer.invoke("omnirush:browser:reorderTabs", tabIds); },
    approve(tabId, approvalId, allowed) { return ipcRenderer.invoke("omnirush:browser:approve", tabId, approvalId, allowed); },
    taskControl(tabId, action) { return ipcRenderer.invoke("omnirush:browser:taskControl", tabId, action); },
    listTabs() { return ipcRenderer.invoke("omnirush:browser:listTabs"); },
    listWebMcpTools(args) { return ipcRenderer.invoke("omnirush:browser:webmcpListTools", args); },
    executeWebMcpTool(args) { return ipcRenderer.invoke("omnirush:browser:webmcpExecuteTool", args); },
    setProxy(proxy) { return ipcRenderer.invoke("omnirush:browser:setProxy", proxy); },
    getProxy() { return ipcRenderer.invoke("omnirush:browser:getProxy"); },
    setControlEnabled(enabled) { return ipcRenderer.invoke("omnirush:browser:setControlEnabled", enabled); },
    showTabContextMenu(tabId, point) { return ipcRenderer.invoke("omnirush:browser:tabContextMenu", tabId, point); },
    destroy() { return ipcRenderer.invoke("omnirush:browser:destroy"); },
    onStateChange(callback) {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("omnirush:browser:state", handler);
      return () => ipcRenderer.removeListener("omnirush:browser:state", handler);
    },
    onPanelOpened(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("omnirush:browser:panel-opened", handler);
      return () => ipcRenderer.removeListener("omnirush:browser:panel-opened", handler);
    },
    onPanelClosed(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("omnirush:browser:panel-closed", handler);
      return () => ipcRenderer.removeListener("omnirush:browser:panel-closed", handler);
    },
  },
  browserLogins: {
    disableForManagedContext() { return ipcRenderer.invoke("omnirush:browser-logins:disableForManagedContext"); },
    sources() { return ipcRenderer.invoke("omnirush:browser-logins:sources"); },
    preview(request) { return ipcRenderer.invoke("omnirush:browser-logins:preview", request); },
    configure(request) { return ipcRenderer.invoke("omnirush:browser-logins:configure", request); },
    state() { return ipcRenderer.invoke("omnirush:browser-logins:state"); },
    syncNow() { return ipcRenderer.invoke("omnirush:browser-logins:syncNow"); },
    pause() { return ipcRenderer.invoke("omnirush:browser-logins:pause"); },
    resume() { return ipcRenderer.invoke("omnirush:browser-logins:resume"); },
    stopSite(site) { return ipcRenderer.invoke("omnirush:browser-logins:stopSite", site); },
    disconnect(request) { return ipcRenderer.invoke("omnirush:browser-logins:disconnect", request); },
    signedInSites() { return ipcRenderer.invoke("omnirush:browser-logins:signedIn"); },
    forgetSite(site) { return ipcRenderer.invoke("omnirush:browser-logins:forgetSite", site); },
    forgetAll() { return ipcRenderer.invoke("omnirush:browser-logins:forgetAll"); },
    ...(process.env.OMNIRUSH_EVAL_BROWSER_LOGIN_SYNC === "1" ? {
      writeTestStore(request) { return ipcRenderer.invoke("omnirush:browser-logins:writeTestStore", request); },
      testWitnessUrl() { return ipcRenderer.invoke("omnirush:browser-logins:testWitnessUrl"); },
    } : {}),
  },
  terminal: {
    create(options) { return ipcRenderer.invoke("omnirush:terminal:create", options); },
    write(terminalId, data) { return ipcRenderer.invoke("omnirush:terminal:write", terminalId, data); },
    resize(terminalId, cols, rows) { return ipcRenderer.invoke("omnirush:terminal:resize", terminalId, cols, rows); },
    kill(terminalId) { return ipcRenderer.invoke("omnirush:terminal:kill", terminalId); },
    onData(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("omnirush:terminal:data", handler);
      return () => ipcRenderer.removeListener("omnirush:terminal:data", handler);
    },
    onExit(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("omnirush:terminal:exit", handler);
      return () => ipcRenderer.removeListener("omnirush:terminal:exit", handler);
    },
  },
  meta: {
    desktopBootstrap,
    distribution: desktopDistribution,
    initialDeepLinks: [],
    platform: normalizePlatform(process.platform),
    version: process.versions.electron,
    evalFatalBootstrapFailure: process.env.OMNIRUSH_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE ?? null,
  },
});

if (
  process.env.OMNIRUSH_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE
  && (process.env.OMNIRUSH_EVAL_RECOVERY_CANDIDATES || process.env.OMNIRUSH_EVAL_RECOVERY_RELEASES)
) {
  contextBridge.exposeInMainWorld("__omnirushRecoveryControl", {
    snapshot() {
      return ipcRenderer.invoke("omnirush:recovery:evalSnapshot");
    },
    select(id) {
      return ipcRenderer.invoke("omnirush:recovery:use", id);
    },
  });
}

ipcRenderer.on(NATIVE_DEEP_LINK_EVENT, (_event, urls) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_DEEP_LINK_EVENT, { detail: urls }));
});

ipcRenderer.on(NATIVE_MENU_OPEN_SETTINGS_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_OPEN_SETTINGS_EVENT));
});

ipcRenderer.on(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT));
});

ipcRenderer.on(NATIVE_MENU_CHECK_UPDATES_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_CHECK_UPDATES_EVENT));
});

ipcRenderer.on(NATIVE_MENU_ZOOM_EVENT, (_event, action) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_MENU_ZOOM_EVENT, { detail: action }));
});

if (!applyShellDocumentMarkers() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", applyShellDocumentMarkers, { once: true });
}

if (!installMenuOverlayDismissListeners() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", installMenuOverlayDismissListeners, { once: true });
}
