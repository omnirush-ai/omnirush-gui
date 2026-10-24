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
import { useDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";

import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "./settings-layout";
import {
  SAME_AS_MAIN_LABEL,
  SUBAGENT_EFFORT_HELP,
  SUBAGENT_MODEL_PINNED_HELP,
  subagentEffortLabel,
  subagentEffortOptions,
  subagentPinnedSummary,
  useSubagentModel,
  type SubagentModelClient,
} from "./subagent-model";

const SAME = "__same_as_main__";

/**
 * Settings > Preferences > Model: "Sub-agents: model" (each chat's own: one
 * model per chat, not a choice) and "Sub-agent effort".
 * Shares its state with the composer's Sub-agents menu (useSubagentModel).
 */
export function SubagentModelSettings(props: { client: SubagentModelClient | null; busy?: boolean }) {
  const policyLocked = useDesktopRestriction("allowControlSettings");
  const { state, setting, loading, saving, error, change } = useSubagentModel(props.client);
  if (!props.client) return null;
  const disabled = Boolean(props.busy) || policyLocked || saving || loading || !state;
  const effortItems = [
    { value: SAME, label: SAME_AS_MAIN_LABEL },
    ...subagentEffortOptions(state, null).map((effort) => ({ value: effort, label: subagentEffortLabel(effort) })),
  ];

  const save = (next: { effort?: string | null }) => {
    void change(next)
      .then((saved) => toast.success(`Sub-agents: ${subagentPinnedSummary(saved.effort)}. Applies to new tasks.`))
      .catch((reason: unknown) => toast.error(reason instanceof Error ? reason.message : "The sub-agent setting could not be saved."));
  };

  const status = policyLocked
    ? "Locked by your organisation: its policy does not allow changing app settings."
    : state && !state.signedIn
      ? "Sign in to omnirush.ai to set the sub-agent effort."
      : error;

  return (
    <>
      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>Sub-agents: model</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>
            {SUBAGENT_MODEL_PINNED_HELP}
            {status ? <span className="mt-1 block" data-testid="subagent-model-status">{status}</span> : null}
          </LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            {/* Not a choice: a chat keeps one model, its sub-agents' too (model-modes.ts). */}
            <span className="w-56 max-w-full text-sm text-muted-foreground" aria-disabled="true" data-testid="settings-subagent-model-pinned">Each chat's own model</span>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
      </LayoutSectionItem>
      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>Sub-agent effort</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{SUBAGENT_EFFORT_HELP}</LayoutSectionItemDescription>
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
                <SelectTrigger className="w-full" aria-label="Sub-agent effort" data-testid="settings-subagent-effort">
                  <SelectValue placeholder={SAME_AS_MAIN_LABEL} />
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
