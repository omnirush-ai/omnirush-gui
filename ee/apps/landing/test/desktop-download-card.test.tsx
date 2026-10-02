import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DesktopDownloadCard } from "../components/desktop-download-card";
import type { DesktopInstallers } from "../lib/github";

const release = "https://github.com/omnirush-ai/omnirush-gui/releases/download/v2.2.17";
const installers: DesktopInstallers = {
  macos: { appleSilicon: `${release}/omnirush-mac-arm64-2.2.17.dmg`, intel: `${release}/omnirush-mac-arm64-2.2.17.dmg` },
  linux: {
    appImageX64: `${release}/omnirush-linux-x86_64-2.2.17.AppImage`,
    appImageArm64: `${release}/omnirush-linux-arm64-2.2.17.AppImage`,
    tarX64: `${release}/omnirush-linux-x64-2.2.17.tar.gz`,
    tarArm64: `${release}/omnirush-linux-arm64-2.2.17.tar.gz`
  }
};

const render = (windowsVisitor: boolean) =>
  renderToStaticMarkup(createElement(DesktopDownloadCard, { installers, releaseTag: "v2.2.17", windowsVisitor }));

const wslLink = (html: string) => html.match(/<a [^>]*data-testid="wsl-setup-link"[^>]*>/)?.[0] ?? "";

describe("Desktop download card", () => {
  test("puts WSL where Windows used to be, between macOS and Linux", () => {
    const html = render(false);
    const macos = html.indexOf(">macOS<");
    const wsl = html.indexOf(">WSL<");
    const linux = html.indexOf(">Linux<");
    expect(macos).toBeGreaterThan(-1);
    expect(wsl).toBeGreaterThan(macos);
    expect(linux).toBeGreaterThan(wsl);
    expect(html).toContain("Using Windows? Switch to WSL");
    expect(html).toContain("OmniRush runs in WSL on Windows, with the command-line tool in Ubuntu.");
    expect(html).toContain('href="https://learn.microsoft.com/windows/wsl/install"');
    expect(html).not.toMatch(/\.(exe|msi)"/i);
    expect(html).not.toContain("/download/windows");
  });

  test("the WSL button goes to our own steps, and is recommended for a Windows visitor", () => {
    const windows = render(true);
    expect(wslLink(windows)).toContain('href="https://omnirush.ai/docs#windows"');
    expect(wslLink(windows)).toContain('data-recommended="true"');
    expect(windows.match(/data-recommended="true"/g)?.length).toBe(1);
    expect(windows).toContain("For your device");
    expect(windows).toContain("Detected · Windows");
  });

  test("other visitors see WSL as a plain choice", () => {
    const other = render(false);
    expect(wslLink(other)).toContain('href="https://omnirush.ai/docs#windows"');
    expect(wslLink(other)).not.toContain("data-recommended");
    expect(other).not.toContain("Detected · Windows");
  });
});
