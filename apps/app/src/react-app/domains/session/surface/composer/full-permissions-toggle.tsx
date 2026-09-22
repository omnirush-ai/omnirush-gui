/** @jsxImportSource react */
import { LoaderCircle, ShieldCheck } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import {
  approvalsEnvironmentHint,
  useApprovalMode,
  type ApprovalsClient,
} from "@/react-app/domains/settings/approval-mode";

export const FULL_PERMISSIONS_ON_HINT =
  "Full permissions on: nothing asks for approval. Switch off to return to guarded mode.";
export const FULL_PERMISSIONS_OFF_HINT =
  "Guarded mode: the engine asks before risky commands. Switch on to run every command and edit files without asking. Organisation policies still apply.";
export const FULL_PERMISSIONS_POLICY_LOCK =
  "Locked by your organisation: its policy does not allow changing app settings.";
export const FULL_PERMISSIONS_LOADING_HINT = "Loading the approval mode…";

type Props = {
  client: ApprovalsClient | null;
  /** Engine reloaded after a change; without one the setting is saved and a reload is asked for. */
  workspaceId: string | null;
};

/**
 * The composer's "Full permissions" switch, beside the model selector. It
 * shares state with Settings > General > Approvals through useApprovalMode,
 * so the two never disagree. Hidden until a server client exists.
 */
export function FullPermissionsToggle(props: Props) {
  const policyLocked = useDesktopRestriction("allowControlSettings");
  if (!props.client) return null;
  return <FullPermissionsSwitch client={props.client} workspaceId={props.workspaceId} policyLocked={policyLocked} />;
}

function FullPermissionsSwitch(props: { client: ApprovalsClient; workspaceId: string | null; policyLocked: boolean }) {
  const { approvals, busy, status, setFullPermissions } = useApprovalMode(props.client, props.workspaceId);
  const full = approvals?.mode === "full";
  const lockReason = props.policyLocked
    ? FULL_PERMISSIONS_POLICY_LOCK
    : approvals
      ? approvalsEnvironmentHint(approvals)
      : null;
  // Disabled while the mode loads, while a change is in flight and while the
  // environment or the organisation forces the mode.
  const disabled = busy || !approvals || lockReason !== null;
  const hint = lockReason
    ?? (!approvals ? (status || FULL_PERMISSIONS_LOADING_HINT) : full ? FULL_PERMISSIONS_ON_HINT : FULL_PERMISSIONS_OFF_HINT);

  const toggle = async () => {
    if (disabled) return;
    const change = await setFullPermissions(!full);
    if (!change) return;
    if (change.tone === "success") toast.success(change.status);
    else if (change.tone === "warning") toast.warning(change.status);
    else toast.error(change.status);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            role="switch"
            aria-checked={full}
            aria-label="Full permissions"
            aria-disabled={disabled || undefined}
            aria-busy={busy || undefined}
            data-testid="full-permissions-toggle"
            data-state={full ? "on" : "off"}
            data-lock-reason={lockReason ?? undefined}
            onClick={() => void toggle()}
            // Same height, radius, padding and text size as the model selector
            // trigger. Kept focusable while disabled (aria-disabled, not
            // disabled) so the tooltip can explain why.
            className={`flex h-9 max-h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-60 ${
              full
                ? "bg-[var(--dls-accent)] text-[var(--dls-accent-fg)] hover:bg-[var(--dls-accent-hover)] aria-disabled:hover:bg-[var(--dls-accent)]"
                : "text-gray-10 hover:bg-gray-3 hover:text-gray-12 aria-disabled:hover:bg-transparent aria-disabled:hover:text-gray-10"
            }`}
          />
        }
      >
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
        <span className="whitespace-nowrap">Full permissions</span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
