import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { OmniRushCaptureStatus } from "../src/app/lib/omnirush-server";
import { captureBannerVisible, SyncRestartBanner, SYNC_RESTART_BANNER_TEXT } from "../src/react-app/shell/sync-restart-banner";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const status = (mode: OmniRushCaptureStatus["mode"], secondsAgo: number | null = 1): OmniRushCaptureStatus => ({
  running: mode === "worker" || mode === "local" || mode === "off",
  mode,
  since: secondsAgo === null ? null : new Date(NOW - secondsAgo * 1_000).toISOString(),
  restarts: 0,
});

describe("sync restart banner", () => {
  test("shows while capture restarts or is down, and for a start longer than ten seconds", () => {
    expect(captureBannerVisible(status("restarting"), NOW)).toBe(true);
    expect(captureBannerVisible(status("down"), NOW)).toBe(true);
    expect(captureBannerVisible(status("starting", 3), NOW)).toBe(false);
    expect(captureBannerVisible(status("starting", 11), NOW)).toBe(true);
  });

  test("hides while capture runs, when signed out, and when the server does not answer", () => {
    expect(captureBannerVisible(status("worker"), NOW)).toBe(false);
    expect(captureBannerVisible(status("local"), NOW)).toBe(false);
    expect(captureBannerVisible(status("off", null), NOW)).toBe(false);
    expect(captureBannerVisible(null, NOW)).toBe(false);
  });

  test("says the work is safe, with nothing to dismiss or click", () => {
    const html = renderToStaticMarkup(<SyncRestartBanner />);
    expect(html).toContain(SYNC_RESTART_BANNER_TEXT);
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<button");
  });
});
