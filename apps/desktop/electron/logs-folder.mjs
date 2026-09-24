import path from "node:path";

/**
 * The folder that holds the desktop app's on-disk logs, among them the
 * built-in server's omnirush-server.log (see resolveOmniRushServerLogFile).
 * It is always <userData>/logs; nothing the renderer sends can change it.
 */
export function resolveDesktopLogsDir(userDataPath) {
  const base = typeof userDataPath === "string" ? userDataPath.trim() : "";
  if (!base || !path.isAbsolute(base)) {
    throw new Error("The app data folder is unavailable.");
  }
  return path.join(base, "logs");
}

/**
 * Builds the handler behind Settings > Diagnostics > "Open logs folder".
 *
 * It takes no input from the renderer: every argument after the IPC event is
 * ignored, so a compromised page cannot turn it into a generic "open this
 * path" call. Only the main window's top frame may call it. The folder is
 * created first, so the button works before the server has written a log.
 *
 * @param {{
 *   getUserDataPath: () => string,
 *   isTrustedSender: (event: any) => boolean,
 *   ensureDir: (dir: string) => Promise<unknown>,
 *   openPath: (dir: string) => Promise<string>,
 * }} deps
 */
export function createOpenLogsFolderHandler(deps) {
  /**
   * @param {unknown} event
   * @param {unknown[]} _ignored renderer arguments, never used
   */
  return async function openLogsFolder(event, ..._ignored) {
    if (!deps.isTrustedSender(event)) {
      return { ok: false, error: "Only the main window can open the logs folder." };
    }
    let dir;
    try {
      dir = resolveDesktopLogsDir(deps.getUserDataPath());
      await deps.ensureDir(dir);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The logs folder could not be created." };
    }
    const failure = await deps.openPath(dir);
    if (typeof failure === "string" && failure.trim()) {
      return { ok: false, error: failure.trim() };
    }
    return { ok: true };
  };
}
