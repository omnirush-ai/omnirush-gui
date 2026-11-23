// @omnirush/browser-logins/linux-keyring — Chrome-family cookie keys on Linux.
//
// Chromium on Linux encrypts cookie values two ways: `v10` with a key from the
// built-in password "peanuts" (no key ring, or `--password-store=basic`) and
// `v11` with a password kept in the desktop key ring (GNOME Keyring or KWallet
// through libsecret). The key ring password is read with `secret-tool`, the
// libsecret command-line client, using the attribute the browser stores it
// under. No key ring, no `secret-tool` or a locked ring that stays locked: the
// `v10` key still works and `v11` values fall back to the empty password the
// browser itself uses when the ring answers nothing.

import { execFile as nodeExecFile } from "node:child_process";

import { deriveChromiumKey } from "./node.mjs";

/**
 * The libsecret `application` attribute each browser stores its password under,
 * in the order to try. Google-branded Chrome uses "chrome", other Chromium
 * builds "chromium"; Brave keeps its own name.
 */
export const LINUX_KEYRING_APPLICATIONS = Object.freeze({
  chrome: ["chrome"],
  chromium: ["chromium"],
  brave: ["brave", "chromium"],
  edge: ["chromium", "chrome"],
  vivaldi: ["chrome", "chromium"],
});

const LOOKUP_TIMEOUT_MS = 60_000;

function lookup(execFile, application) {
  return new Promise((resolve) => {
    try {
      execFile("secret-tool", ["lookup", "application", application], { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const password = String(stdout ?? "").replace(/\r?\n$/, "");
        resolve(password || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** The key ring password for a Chrome-family browser, or null when there is none to read. */
export async function readLinuxKeyringPassword(browser, { execFile = nodeExecFile } = {}) {
  for (const application of LINUX_KEYRING_APPLICATIONS[browser] ?? []) {
    const password = await lookup(execFile, application);
    if (password) return password;
  }
  return null;
}

/** The keys for `decryptChromiumValue` on Linux: `v10` from "peanuts", `v11` from the key ring (then the empty password). */
export function linuxChromiumKeys(password) {
  const v11 = password ? [deriveChromiumKey(password, { platform: "linux" })] : [];
  v11.push(deriveChromiumKey("", { platform: "linux" }));
  return { v10: [deriveChromiumKey("peanuts", { platform: "linux" })], v11 };
}
