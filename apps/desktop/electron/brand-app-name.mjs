const MAX_APP_NAME_LENGTH = 64;

/**
 * Apply a branded display name to Electron and every native surface that
 * derives from it. The macOS menu-bar label follows the process title, while
 * Electron-owned labels follow app.getName(), so both must change before the
 * application menu rebuilds.
 *
 * @param {unknown} requestedName
 * @param {{
 *   fallbackName: string,
 *   electronFallbackName?: string,
 *   platform: string,
 *   updateElectronAppName: boolean,
 *   runtimeProcess: { title: string },
 *   app: { setName: (name: string) => void, setAboutPanelOptions?: (options: { applicationName: string }) => void },
 *   applicationMenu: { setAppName: (name: string) => unknown },
 *   window?: { setTitle: (name: string) => void } | null,
 * }} dependencies
 */
export function applyBrandAppName(requestedName, dependencies) {
  const requested = requestedName === null ? "" : String(requestedName ?? "").trim();
  const appName = requested.slice(0, MAX_APP_NAME_LENGTH) || dependencies.fallbackName;

  if (dependencies.platform === "darwin") {
    dependencies.runtimeProcess.title = appName;
    dependencies.app.setAboutPanelOptions?.({ applicationName: appName });
  }
  if (dependencies.updateElectronAppName) {
    // Without a brand, Electron keeps its own name (it names the keychain
    // item); only the visible surfaces take the display name.
    dependencies.app.setName(requested ? appName : dependencies.electronFallbackName ?? appName);
  }
  dependencies.applicationMenu.setAppName(appName);
  dependencies.window?.setTitle(appName);

  return appName;
}
