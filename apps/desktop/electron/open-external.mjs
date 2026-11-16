import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 4000;

// Schemes the app hands to the OS. Everything else (file:, smb:, ms-msdt:,
// search-ms:, javascript: ...) can run or fetch something, so it is refused.
// The two settings schemes open the microphone privacy pane (voice/mic-source.ts).
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "ms-settings:", "x-apple.systempreferences:"]);

function protocolOf(url) {
  try {
    return new URL(String(url)).protocol;
  } catch {
    return null;
  }
}

function describeError(error) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error ?? "unknown error");
}

async function defaultOpenExternal(url) {
  const electron = await import("electron");
  if (typeof electron.shell?.openExternal !== "function") {
    throw new Error("Electron shell.openExternal is unavailable");
  }
  await electron.shell.openExternal(url);
}

export async function openExternalUrl(url, deps = {}) {
  const protocol = protocolOf(url);
  if (!protocol || !ALLOWED_PROTOCOLS.has(protocol)) {
    const message = protocol ? `protocol "${protocol}" is not allowed` : "not a valid URL";
    console.error("[shell] openExternal refused:", message);
    return { ok: false, error: message };
  }

  const env = deps.env ?? process.env;
  if (env.OMNIRUSH_SIMULATE_OPEN_EXTERNAL_FAILURE === "1") {
    const message = "simulated failure";
    // why: enables evals to prove the failure UX without breaking a real machine.
    console.error("[shell] openExternal failed:", message);
    return { ok: false, error: message };
  }

  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  const openExternal = deps.openExternal ?? defaultOpenExternal;
  let timeoutId = null;

  try {
    // why: shell.openExternal can hang forever on Windows machines with broken https URL associations; silence is the bug we're fixing.
    await Promise.race([
      Promise.resolve().then(() => openExternal(url)),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return { ok: true };
  } catch (error) {
    const message = describeError(error);
    console.error("[shell] openExternal failed:", message);

    const platform = deps.platform ?? process.platform;
    // why: FileProtocolHandler also runs local files, so only web links take the fallback.
    if (platform === "win32" && (protocol === "http:" || protocol === "https:")) {
      const spawnProcess = deps.spawnProcess ?? spawn;
      try {
        console.error("[shell] attempting rundll32 browser fallback");
        const child = spawnProcess("rundll32", ["url.dll,FileProtocolHandler", url], {
          detached: true,
          stdio: "ignore",
        });
        if (typeof child?.unref === "function") child.unref();
      } catch (spawnError) {
        console.error("[shell] rundll32 browser fallback failed:", describeError(spawnError));
      }
    }

    return { ok: false, error: message };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
