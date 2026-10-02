// OmniRush has no native Windows app: on Windows it runs in WSL. Same wording
// and link as the main website (omnirush.ai, omnirush-ai.github.io #14).
export const WSL_INSTALL_URL = "https://learn.microsoft.com/windows/wsl/install";

/** True for a Windows desktop user agent (the request's or the browser's). */
export function isWindowsUserAgent(userAgent: string): boolean {
  return /windows nt/i.test(userAgent);
}

export function WslLine({ className }: { className?: string }) {
  return (
    <p data-testid="wsl-line" className={className}>
      On Windows? OmniRush runs in WSL.{" "}
      <a
        href={WSL_INSTALL_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="whitespace-nowrap font-medium text-[var(--lp-ink,#07192C)] underline underline-offset-4"
      >
        Install WSL <span aria-hidden="true">↗</span>
      </a>
    </p>
  );
}
