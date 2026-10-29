// Runtime detection primitives. Leaf module by design: keep it import-free so
// low-level clients (opencode, omnirush-server, den) can use it without
// dragging in the utils barrel (which pulls i18n and app constants).
export function isElectronRuntime() {
  return typeof window !== "undefined" && (window as Window).__OMNIRUSH_ELECTRON__ != null;
}

export function isDesktopRuntime() {
  return isElectronRuntime();
}

/** Stock mode (the server's stock-mode.mjs): the app started with OMNIRUSH_FARM=1, chats run stock OpenCode on Astra. */
export function isStockMode() {
  return isElectronRuntime() && window.__OMNIRUSH_ELECTRON__?.meta?.stockMode === true;
}

/** Stock mode a hackathon turned on: the app says nothing about the mode itself then. */
export function isEventMode() {
  return isElectronRuntime() && window.__OMNIRUSH_ELECTRON__?.meta?.eventMode === true;
}
