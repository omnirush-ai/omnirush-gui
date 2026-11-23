/** @jsxImportSource react */
// Settings > Browser: the in-app browser's sign-ins (and importing from other browsers, mounted here). A company account
// (OmniRush Work) has it as its own tab; everyone else sees the same sections under Permissions.
import { BrowserLoginsPanel } from "../../browser-logins/browser-logins-panel";
import { BrowserImportSection } from "../../browser-logins/import-section";
import { BrowserSitePermissionsSection } from "../../browser-logins/site-permissions-section";
import { SettingsStack } from "../settings-section";

/** The browser sections, wherever Settings shows them. Importing is for Work accounts; it renders nothing otherwise. */
export function BrowserSettingsSections() {
  return (
    <>
      <BrowserImportSection />
      <BrowserSitePermissionsSection />
      <BrowserLoginsPanel />
    </>
  );
}

export function BrowserSettingsView() {
  return (
    <SettingsStack>
      <BrowserSettingsSections />
    </SettingsStack>
  );
}
