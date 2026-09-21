// Runtime detection primitives. Leaf module by design: keep it import-free so
// low-level clients (opencode, omnirush-server, den) can use it without
// dragging in the utils barrel (which pulls i18n and app constants).
export function isElectronRuntime() {
  return typeof window !== "undefined" && (window as Window).__OMNIRUSH_ELECTRON__ != null;
}

export function isDesktopRuntime() {
  return isElectronRuntime();
}
