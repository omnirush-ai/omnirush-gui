// OmniRush has no native Windows app: on Windows it runs in WSL, with the
// command-line tool in Ubuntu. WSL takes the place Windows used to have next
// to macOS and Linux. The wording matches omnirush.ai and the console.
export const WSL_HEADLINE = "Using Windows? Switch to WSL";
export const WSL_SENTENCE = "OmniRush runs in WSL on Windows, with the command-line tool in Ubuntu.";
export const WSL_BUTTON = "Set up WSL";
/** Our own WSL steps (primary). */
export const WSL_STEPS_URL = "https://omnirush.ai/docs#windows";
/** Microsoft's page (secondary). */
export const WSL_INSTALL_URL = "https://learn.microsoft.com/windows/wsl/install";
export const WSL_INSTALL_LABEL = "Microsoft's install guide";

/** True for a Windows desktop user agent. */
export function isWindowsUserAgent(userAgent: string): boolean {
  return /windows nt/i.test(userAgent);
}
