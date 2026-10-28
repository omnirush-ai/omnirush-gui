/** @jsxImportSource react */
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The other Preferences sections need the desktop's providers; this test is about the Model section only.
mock.module("@/react-app/domains/settings/desktop-integration-section", () => ({ DesktopIntegrationSection: () => null }));
mock.module("@/react-app/domains/cloud/desktop-config-provider", () => ({ useDesktopRestriction: () => false, useCheckDesktopRestriction: () => () => false }));

const { PreferencesView } = await import("../src/react-app/domains/settings/pages/preferences-view");

describe("settings default model", () => {
  test("Preferences shows the default model for new chats and a control that changes it", () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
      <PreferencesView
        busy={false}
        defaultModelLabel="OmniRush - GPT 6 Astra"
        onChangeDefaultModel={() => {}}
        showThinking
        onToggleShowThinking={() => {}}
        autoCompactContext
        autoCompactContextBusy={false}
        onToggleAutoCompactContext={() => {}}
        desktopNotifications="important"
        onDesktopNotificationsChange={() => {}}
      />
      </QueryClientProvider>,
    );
    expect(markup).toContain("Default model");
    expect(markup).toMatch(/data-testid="settings-default-model">OmniRush - GPT 6 Astra</);
    expect(markup).toMatch(/<button[^>]*data-testid="settings-default-model-change"[^>]*>Change<\/button>/);
  });
});

describe("the default-model picker's models", () => {
  test("keep the account's own models without a cloud org sign-in", async () => {
    const { visibleModelOptions } = await import("../src/react-app/domains/session/modals/use-model-picker");
    const option = (providerID: string, modelID: string) => ({ providerID, modelID, title: modelID, description: "", isFree: false });
    const engine = [option("omnirush", "gpt-6-astra"), option("omnirush", "kimi-k3.1-pro")];
    const org = [option("lpr_team", "shared")];
    const ids = (list: { providerID: string; modelID: string }[]) => list.map((item) => `${item.providerID}/${item.modelID}`);
    expect(ids(visibleModelOptions(engine, org, false))).toEqual(["omnirush/gpt-6-astra", "omnirush/kimi-k3.1-pro"]);
    expect(ids(visibleModelOptions(engine, org, true))).toContain("omnirush/gpt-6-astra");
  });
});
