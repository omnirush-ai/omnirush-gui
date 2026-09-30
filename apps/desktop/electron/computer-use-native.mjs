import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function createNativeDesktop() {
  const worker = spawn(process.execPath, [fileURLToPath(new URL("./computer-use-native-worker.mjs", import.meta.url))], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true, serialization: "advanced" });
  const pending = new Map();
  const listeners = new Set();
  let nextId = 0, closed = false;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const readyTimer = setTimeout(() => readyResolve({ supported: false, error: "Desktop access did not start. Restart OmniRush.ai." }), 10_000);
  worker.on("message", (value) => {
    if (!record(value)) return;
    if (value.event === "ready") { clearTimeout(readyTimer); readyResolve(value); }
    if (value.event === "person-input") for (const listener of listeners) listener(value);
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id); clearTimeout(request.timer);
    if (record(value.error) && typeof value.error.message === "string") request.reject(Object.assign(new Error(value.error.message), { code: value.error.code }));
    else request.resolve(value.result);
  });
  const fail = (error) => {
    clearTimeout(readyTimer); readyResolve({ supported: false, error: error.message });
    closed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    for (const listener of listeners) listener({ event: "unavailable" });
  };
  worker.on("error", fail);
  worker.on("exit", () => fail(new Error("Desktop access stopped. Restart OmniRush.ai.")));
  return {
    ready,
    grantForeground() {
      if (process.platform !== "win32" || !worker.pid) return;
      const koffi = createRequire(import.meta.url)("koffi");
      koffi.load("user32.dll").func("int __stdcall AllowSetForegroundWindow(uint32_t processId)")(worker.pid);
    },
    onInput(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    call(method, params = {}) {
      if (closed) return Promise.reject(new Error("Desktop access has stopped."));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Desktop operation timed out.")); }, 10_000);
        pending.set(id, { resolve, reject, timer }); worker.send({ id, method, params });
      });
    },
    async close() { if (closed) return; await this.call("shutdown").catch(() => {}); closed = true; if (worker.exitCode === null) worker.kill(); },
  };
}
