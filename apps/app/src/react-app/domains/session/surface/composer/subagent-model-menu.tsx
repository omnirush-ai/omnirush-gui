/** @jsxImportSource react */
import { useState } from "react";
import { LoaderCircle, Users } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import {
  SAME_AS_MAIN_LABEL,
  SUBAGENT_MODEL_PINNED_HELP,
  subagentEffortLabel,
  subagentEffortOptions,
  subagentPinnedLabel,
  subagentPinnedSummary,
  useSubagentModel,
  type SubagentModelClient,
} from "@/react-app/domains/settings/subagent-model";

const SAME = "__same_as_main__";

export const SUBAGENT_MENU_POLICY_LOCK = "Locked by your organisation: its policy does not allow changing app settings.";

/**
 * The composer's "Sub-agents" menu beside the model selector. One model per
 * chat: sub-agents run on the chat's model (`chatModel`, shown, not a
 * choice); only their effort is set here (default: the main agent's). Shares
 * its state with Settings > Preferences through useSubagentModel. Hidden
 * until a server client exists and an omnirush.ai account is signed in.
 */
export function SubagentModelMenu(props: { client: SubagentModelClient | null; chatModel?: string | null }) {
  const policyLocked = useDesktopRestriction("allowControlSettings");
  if (!props.client) return null;
  return <SubagentModelPicker client={props.client} chatModel={props.chatModel ?? null} policyLocked={policyLocked} />;
}

function SubagentModelPicker(props: { client: SubagentModelClient; chatModel: string | null; policyLocked: boolean }) {
  const [open, setOpen] = useState(false);
  const { state, setting, saving, error, change, refetch } = useSubagentModel(props.client);
  if (!state?.signedIn || state.models.length === 0) return null;
  const pinned = subagentPinnedLabel(state, props.chatModel);
  const summary = subagentPinnedSummary(setting.effort);
  const custom = Boolean(setting.effort);
  const locked = props.policyLocked || saving;
  const efforts = subagentEffortOptions(state, props.chatModel);

  const save = (next: { effort?: string | null }) => {
    if (locked) return;
    void change(next)
      .then((saved) => toast.success(`Sub-agents: ${subagentPinnedSummary(saved.effort)}. Applies to new tasks.`))
      .catch((reason: unknown) => toast.error(reason instanceof Error ? reason.message : "The sub-agent setting could not be saved."));
  };

  return (
    <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (next) void refetch(); }}>
      <DropdownMenuTrigger
        data-testid="subagent-model-trigger"
        aria-label={`Sub-agents: ${summary}`}
        title={props.policyLocked ? SUBAGENT_MENU_POLICY_LOCK : `Sub-agents: ${summary}. ${pinned}.`}
        // An icon (the summary in its tooltip) until the composer is wide
        // enough for the label, so it never squeezes the model selector.
        className={`flex h-9 max-h-9 min-w-9 max-w-64 shrink-[4] items-center justify-center gap-1.5 overflow-hidden rounded-md px-2.5 text-sm transition-colors hover:bg-gray-3 @min-[720px]/composer:justify-start ${
          custom ? "text-gray-12" : "text-gray-10 hover:text-gray-12"
        }`}
      >
        {saving ? <LoaderCircle className="size-4 shrink-0 animate-spin" /> : <Users className="size-4 shrink-0" />}
        <span data-testid="subagent-model-label" className="hidden min-w-0 truncate whitespace-nowrap @min-[720px]/composer:inline">{custom ? summary : "Sub-agents"}</span>
      </DropdownMenuTrigger>
      {/* Capped to the room the positioner measured, so a long menu scrolls inside the viewport instead of running off it. */}
      <DropdownMenuContent side="top" sideOffset={10} className="max-h-[min(560px,var(--available-height))] w-[min(340px,calc(100vw-32px))] overflow-y-auto p-2">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-3 text-sm">Sub-agents: model</DropdownMenuLabel>
          {/* Not a choice: a chat keeps one model, its sub-agents' too. */}
          <p data-testid="subagent-model-pinned" aria-disabled="true" className="px-3 py-1.5 text-sm text-muted-foreground">{pinned}</p>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-3 text-sm">Sub-agent effort</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={setting.effort ?? SAME}>
            <DropdownMenuRadioItem value={SAME} disabled={locked} data-testid="subagent-effort-same" onClick={() => save({ effort: null })}>
              {SAME_AS_MAIN_LABEL}
            </DropdownMenuRadioItem>
            {efforts.map((effort) => (
              <DropdownMenuRadioItem
                key={effort}
                value={effort}
                disabled={locked}
                data-testid={`subagent-effort-${effort}`}
                onClick={() => save({ effort })}
              >
                {subagentEffortLabel(effort)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <p className="px-3 py-2 text-xs text-muted-foreground">{SUBAGENT_MODEL_PINNED_HELP}</p>
        {props.policyLocked ? <p role="status" className="px-3 pb-2 text-xs text-muted-foreground">{SUBAGENT_MENU_POLICY_LOCK}</p> : null}
        {error ? <p role="alert" className="px-3 pb-2 text-xs text-destructive">{error}</p> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
