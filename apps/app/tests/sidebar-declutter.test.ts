import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import { MAX_SESSIONS_PREVIEW } from "../src/react-app/domains/session/sidebar/utils";

const sidebar = readFileSync(
  fileURLToPath(new URL("../src/react-app/domains/session/sidebar/app-sidebar.tsx", import.meta.url)),
  "utf8",
);
const between = (from: string, to: string) => {
  const start = sidebar.indexOf(from);
  const end = sidebar.indexOf(to, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sidebar.slice(start, end);
};

// Chat mode: the chat list keeps most of the sidebar height (feedback 01a16431, 3.7.1 on Windows).
describe("chat sidebar keeps the height for chats", () => {
  test("New session and Search share one row", () => {
    const row = between("data-sidebar-new-chat", "</SidebarMenuItem>");
    expect(row).toContain("icon={Search}");
    expect(row).toContain('aria-keyshortcuts={isMacPlatform() ? "Meta+Shift+F" : "Control+Shift+F"}');
  });

  test("the occasional places are one icon row, each one click away", () => {
    const tools = between('data-testid="sidebar-tools"', "</div>");
    for (const needle of [
      'data-testid="audit-trail-toggle"',
      'data-testid="local-workflows-toggle"',
      'label={t("sidebar.dashboard")}',
      'data-testid="sidebar-tasks"',
      'data-testid="sidebar-tasks-running"',
      'label={t("sidebar.automations")}',
      "data-automations-attention-indicator",
      't("settings.tab_extensions")',
      '<NotificationBell variant="sidebar-icon" />',
    ]) expect(tools).toContain(needle);
  });

  test("the footer is the account row plus one row of rewards, feedback, what's new and Settings", () => {
    const footer = between('data-testid="sidebar-footer-tools"', "</div>");
    for (const needle of ["<QualitySpinButtons", 'data-testid="sidebar-send-feedback"', "<WhatsNewIconButton />", 'label={t("settings.tab_general")}']) {
      expect(footer).toContain(needle);
    }
    const spin = between("function QualitySpinButtons", "function WhatsNewIconButton");
    expect(spin).toContain('data-testid="quality-spin-button"');
    expect(spin).toContain('data-testid="quality-footer-next"');
  });

  test("each project shows at least 10 chats before Show more", () => {
    expect(MAX_SESSIONS_PREVIEW).toBeGreaterThanOrEqual(10);
  });
});
