/** @jsxImportSource react */
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { useDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";

import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "./settings-layout";
import {
  subagentEffortLabel,
  subagentEffortOptions,
  subagentModelName,
  subagentModelUnavailable,
  subagentSummary,
  useSubagentModel,
  type SubagentModelClient,
} from "./subagent-model";

const SAME = "__same_as_main__";

/**
 * Settings > Preferences > Model: "Sub-agents: model" and "Sub-agent effort".
 * Shares its state with the composer's Sub-agents menu (useSubagentModel).
 */
export function SubagentModelSettings(props: { client: SubagentModelClient | null; busy?: boolean }) {
  const policyLocked = useDesktopRestriction("allowControlSettings");
  const { state, setting, loading, saving, error, change } = useSubagentModel(props.client);
  if (!props.client) return null;
  const disabled = Boolean(props.busy) || policyLocked || saving || loading || !state;
  const unavailable = subagentModelUnavailable(state, setting);
  const models = state?.models ?? [];
  const modelItems = [
    { value: SAME, label: t("subagent.same_as_main") },
    ...models.map((model) => ({ value: model.id, label: model.family && model.family !== "OpenAI" ? `${model.name} (${model.family})` : model.name })),
    ...(setting.model && unavailable ? [{ value: setting.model, label: `${subagentModelName(state, setting.model)} ${t("subagent.not_available")}` }] : []),
  ];
  const effortItems = [
    { value: SAME, label: t("subagent.same_as_main") },
    ...subagentEffortOptions(state, setting.model).map((effort) => ({ value: effort, label: subagentEffortLabel(effort) })),
  ];

  const save = (next: { model?: string | null; effort?: string | null }) => {
    void change(next)
      .then((saved) => toast.success(t("subagent.saved", { summary: subagentSummary(state, saved) })))
      .catch((reason: unknown) => toast.error(reason instanceof Error ? reason.message : t("subagent.save_failed")));
  };

  const status = policyLocked
    ? t("subagent.policy_lock")
    : state && !state.signedIn
      ? t("subagent.sign_in_hint")
      : unavailable
        ? t("subagent.model_unavailable")
        : error;

  return (
    <>
      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("subagent.model_label")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>
            {t("subagent.model_help")}
            {status ? <span className="mt-1 block" data-testid="subagent-model-status">{status}</span> : null}
          </LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <div className="w-56 max-w-full">
              <Select
                value={setting.model ?? SAME}
                items={modelItems}
                onValueChange={(value) => {
                  if (typeof value === "string") save({ model: value === SAME ? null : value });
                }}
                disabled={disabled || !state?.signedIn}
              >
                <SelectTrigger className="w-full" aria-label={t("subagent.model_label")} data-testid="settings-subagent-model">
                  <SelectValue placeholder={t("subagent.same_as_main")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {modelItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
      </LayoutSectionItem>
      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("subagent.effort_label")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{t("subagent.effort_help")}</LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <div className="w-56 max-w-full">
              <Select
                value={setting.effort ?? SAME}
                items={effortItems}
                onValueChange={(value) => {
                  if (typeof value === "string") save({ effort: value === SAME ? null : value });
                }}
                disabled={disabled || !state?.signedIn}
              >
                <SelectTrigger className="w-full" aria-label={t("subagent.effort_label")} data-testid="settings-subagent-effort">
                  <SelectValue placeholder={t("subagent.same_as_main")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {effortItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
      </LayoutSectionItem>
    </>
  );
}
