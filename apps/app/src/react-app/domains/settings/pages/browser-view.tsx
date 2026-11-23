/** @jsxImportSource react */
// Settings > Browser: the in-app browser's sign-ins (and importing from other browsers, mounted here). A company account
// (OmniRush Work) has it as its own tab; everyone else sees the same sections under Permissions.
import { BrowserLoginsPanel } from "../../browser-logins/browser-logins-panel";
import { SettingsStack } from "../settings-section";

/** The browser sections, wherever Settings shows them. */
export function BrowserSettingsSections() {
  return <BrowserLoginsPanel />;
}

export function BrowserSettingsView() {
  return (
    <SettingsStack>
      <BrowserSettingsSections />
    </SettingsStack>
  );
}
