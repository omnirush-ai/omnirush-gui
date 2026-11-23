/** @jsxImportSource react */
// Settings > Work (OmniRush Work company accounts, enterprise design 2.6): everything about Work in one tab: connectors,
// the organization, how answers read, web search and automation. Consumers keep these rows under Preferences.
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { WorkAnswerStyleSetting } from "@/react-app/domains/work/answer-style";
import { useWorkState, WORK_ACTIVITY_ROUTE, type WorkClient } from "@/react-app/domains/work/work-mode";
import { WorkOrganizationSetting } from "@/react-app/domains/work/work-org";
import { WorkConnectorsSetting } from "@/react-app/domains/work/work-views";

import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";
import { WebSearchSetting, type WebSearchClient } from "../web-search-setting";

/** The way to Work > Automation (autopilot, pausing writes, the activity log). */
function WorkAutomationSetting(props: { client: WorkClient | null }) {
  const navigate = useNavigate();
  const state = useWorkState(props.client);
  if (!state.data?.enabled) return null;
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{t("work.nav.automation")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>{t("work.automation.setting_body")}</LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <Button variant="outline" size="sm" data-testid="settings-work-automation" onClick={() => navigate(WORK_ACTIVITY_ROUTE)}>{t("work.common.open")}</Button>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
    </LayoutSectionItem>
  );
}

export function WorkSettingsView(props: { client: (WorkClient & WebSearchClient) | null; busy?: boolean }) {
  return (
    <LayoutStack>
      <LayoutSection id="settings-work">
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.work_section")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.work_section_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>
        <WorkConnectorsSetting client={props.client} />
        <WorkOrganizationSetting client={props.client} />
        <WorkAnswerStyleSetting client={props.client} />
        <WebSearchSetting client={props.client} busy={props.busy} />
        <WorkAutomationSetting client={props.client} />
      </LayoutSection>
    </LayoutStack>
  );
}
