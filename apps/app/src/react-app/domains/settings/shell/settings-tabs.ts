// Which Settings tabs show (no React, no providers: General's cards, the command palette and tests read it too).
import type { PlatformCapabilities } from "../../../../app/lib/platform-capabilities";
import type { SettingsTab } from "../../../../app/types";
import type { EnterpriseMode } from "../../work/enterprise-mode";

export function getWorkspaceSettingsTabs(): SettingsTab[] {
  return ["preferences", "permissions", "extensions", "advanced"];
}

export function getGlobalSettingsTabs(
  developerMode: boolean,
  capabilities: Pick<PlatformCapabilities, "autoUpdate">,
): SettingsTab[] {
  const tabs: SettingsTab[] = ["ai", "appearance", "editor", "voice", "environment"];
  if (capabilities.autoUpdate) tabs.push("updates");
  if (developerMode) tabs.push("debug");
  return tabs;
}

/**
 * Settings for a company account (OmniRush Work, enterprise design 2.6); null for everyone else (the lists above).
 * Without Code: Work, Browser and the app-wide basics, no workspace tabs, no AI, Editor or Environment (Debug only in
 * developer mode). With Code turned on by staff: the full list, Work first.
 */
export function enterpriseSettingsTabs(
  developerMode: boolean,
  capabilities: Pick<PlatformCapabilities, "autoUpdate">,
  mode: Pick<EnterpriseMode, "on" | "code">,
): { workspace: SettingsTab[]; global: SettingsTab[] } | null {
  if (!mode.on) return null;
  if (mode.code) return { workspace: getWorkspaceSettingsTabs(), global: ["work", ...getGlobalSettingsTabs(developerMode, capabilities)] };
  const global: SettingsTab[] = ["work", "browser", "appearance", "voice"];
  if (capabilities.autoUpdate) global.push("updates");
  if (developerMode) global.push("debug");
  return { workspace: [], global };
}
