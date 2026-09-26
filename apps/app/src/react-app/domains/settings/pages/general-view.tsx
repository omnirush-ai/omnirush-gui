/** @jsxImportSource react */
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Cog,
  FolderLock,
  Mic,
  Paintbrush,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
  UserRoundCheck,
} from "lucide-react";

import type { OmniRushAccountSignOutReason } from "@omnirush/types/desktop-ipc";

import { Switch } from "@/components/ui/switch";
import { t } from "../../../../i18n";
import type { SettingsTab } from "../../../../app/types";
import {
  omnirushAccountConnect,
  omnirushAccountSignOut,
  omnirushAccountStatus,
} from "../../../../app/lib/desktop";
import type { OmniRushRuntimeApprovals } from "../../../../app/lib/omnirush-server";
import { isElectronRuntime } from "../../../../app/utils";
import {
  FULL_PERMISSIONS_HELP,
  approvalsEnvironmentHint,
  useApprovalMode,
  type ApprovalsClient,
} from "../approval-mode";
import { DiagnosticsSection } from "./diagnostics-section";

export type GeneralSettingsViewProps = {
  onNavigateTab: (tab: SettingsTab) => void;
  developerMode: boolean;
  /** Server client for the Approvals card; the card is hidden without one. */
  omnirushClient?: ApprovalsClient | null;
  /** Workspace whose engine is reloaded after the approval mode changes. */
  runtimeWorkspaceId?: string | null;
  /** Builds the sanitized diagnostics bundle with the route's context. */
  buildDiagnosticsBundle?: () => Promise<string>;
};

type NativeAccountStatus = Awaited<ReturnType<typeof omnirushAccountStatus>>;

type SettingsCardDefinition = { tab: SettingsTab; icon: typeof Sparkles } & (
  | { title: string; desc: string }
  | { titleKey: string; descKey: string }
);

const workspaceCards: SettingsCardDefinition[] = [
  { tab: "preferences", icon: Cog, title: "Preferences", desc: "Default model, reasoning, and compaction." },
  { tab: "permissions", icon: FolderLock, title: "Permissions", desc: "Authorized folders and file access." },
  { tab: "advanced", icon: Wrench, title: "Advanced", desc: "Runtime, engine, recovery, and developer options." },
];

const globalCards: SettingsCardDefinition[] = [
  { tab: "ai", icon: Sparkles, title: "AI Providers", desc: "Connect services that provide AI models." },
  { tab: "appearance", icon: Paintbrush, title: "Appearance", desc: "Theme, font size, and display." },
  { tab: "voice", icon: Mic, title: "Voice", desc: "Dictation, microphone, and hotkey." },
  { tab: "environment", icon: Terminal, title: "Environment", desc: "Environment variables and paths." },
  { tab: "updates", icon: RefreshCcw, title: "Updates", desc: "App version and update channel." },
];

function cardTitle(card: SettingsCardDefinition) {
  return "titleKey" in card ? t(card.titleKey) : card.title;
}

function cardDescription(card: SettingsCardDefinition) {
  return "descKey" in card ? t(card.descKey) : card.desc;
}

function SettingsCard(props: {
  icon: typeof Sparkles;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex items-center gap-3 rounded-2xl border border-dls-border bg-dls-surface p-4 text-left transition-colors hover:bg-dls-hover"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
        <props.icon size={16} className="text-dls-secondary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-dls-text">{props.title}</div>
        <div className="text-[11px] text-dls-secondary">{props.desc}</div>
      </div>
      <ArrowRight size={14} className="shrink-0 text-dls-secondary" />
    </button>
  );
}

function compactTokenCount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Math.max(0, value));
}

export type AccountSignOutOutcome = {
  remoteRevoked: boolean;
  /** Absent when the desktop bridge predates the outcome reasons. */
  reason?: OmniRushAccountSignOutReason;
};

/**
 * The settings line shown after sign-out. It names the account server and
 * says exactly what happened to the remote device session.
 */
export function accountSignOutMessage(outcome: AccountSignOutOutcome, server?: string | null): string {
  const host = server?.trim() || "the account server";
  switch (outcome.reason) {
    case "revoked":
      return `Signed out on this device and revoked its device session on ${host}.`;
    case "already_revoked":
      return `Signed out on this device. ${host} had already revoked this device session.`;
    case "endpoint_missing":
      return `Signed out on this device. ${host} has no remote sign-out endpoint, so the device session was not revoked there.`;
    case "unreachable":
      return `Signed out on this device. ${host} could not be reached, so the device session was not revoked there.`;
    default:
      return outcome.remoteRevoked
        ? `Signed out on this device and revoked its device session on ${host}.`
        : `Signed out on this device. The device session on ${host} could not be revoked.`;
  }
}

/** Names the account server the app is connected to, or will connect to on sign-in. */
export function accountServerLine(account: Pick<NativeAccountStatus, "connected" | "gatewayHost">): string | null {
  const host = account.gatewayHost?.trim();
  if (!host) return null;
  return account.connected ? `Connected to ${host}` : `Account server: ${host}`;
}

/**
 * Settings > General > Approvals. The mode, busy flag and status come from
 * useApprovalMode, which the composer's "Full permissions" switch shares.
 */
export function ApprovalsCard(props: {
  approvals: OmniRushRuntimeApprovals | null;
  busy: boolean;
  status: string;
  onToggle: (enabled: boolean) => void;
}) {
  const hint = props.approvals ? approvalsEnvironmentHint(props.approvals) : null;
  const full = props.approvals?.mode === "full";
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
        Approvals
      </div>
      <div className="flex items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
          <ShieldCheck size={17} className={full ? "text-amber-400" : "text-dls-secondary"} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-dls-text">Full permissions</div>
          <div className="text-[11px] text-dls-secondary">{FULL_PERMISSIONS_HELP}</div>
          {hint ? (
            <div className="mt-0.5 text-[11px] text-dls-secondary" data-testid="approvals-env-hint">{hint}</div>
          ) : null}
          {props.status ? (
            <div className="mt-0.5 text-[11px] text-dls-secondary" data-testid="approvals-status">{props.status}</div>
          ) : null}
        </div>
        <Switch
          aria-label="Full permissions"
          checked={full}
          disabled={props.busy || !props.approvals || hint !== null}
          onCheckedChange={props.onToggle}
        />
      </div>
    </div>
  );
}

export function GeneralSettingsView(props: GeneralSettingsViewProps) {
  const [account, setAccount] = useState<NativeAccountStatus | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountMessage, setAccountMessage] = useState("");
  const approvalsClient = props.omnirushClient ?? null;
  const approvalMode = useApprovalMode(approvalsClient, props.runtimeWorkspaceId ?? null);

  useEffect(() => {
    if (!isElectronRuntime()) return;
    void omnirushAccountStatus().then(setAccount).catch(() => setAccount({ connected: false, gatewayConfigured: false }));
  }, []);

  async function connectAccount() {
    setAccountBusy(true);
    setAccountMessage("Approve the device link in your browser…");
    try {
      await omnirushAccountConnect();
      setAccount(await omnirushAccountStatus());
      setAccountMessage("Account connected. omnirush.ai models are ready.");
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "The account could not be connected.");
    } finally {
      setAccountBusy(false);
    }
  }

  async function signOutAccount() {
    setAccountBusy(true);
    // Capture the server before sign-out: afterwards the status reports the
    // default server the next sign-in will use, not the one just left.
    const server = account?.gatewayHost ?? null;
    try {
      const result = await omnirushAccountSignOut();
      const next = await omnirushAccountStatus().catch(() => null);
      setAccount(next ?? { connected: false, gatewayConfigured: account?.gatewayConfigured ?? false });
      setAccountMessage(accountSignOutMessage(result, server));
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "The account could not be signed out.");
    } finally {
      setAccountBusy(false);
    }
  }

  const serverLine = account ? accountServerLine(account) : null;

  return (
    <div className="w-full max-w-3xl space-y-8">
      {isElectronRuntime() && account && (
        <div className="space-y-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
            Account
          </div>
          <div className="flex items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
              <UserRoundCheck size={17} className={account.connected ? "text-emerald-400" : "text-dls-secondary"} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-dls-text">
                {account.connected ? account.displayName || account.email || "Connected" : "Sign in to your account"}
              </div>
              {account.connected && account.email ? (
                <div className="truncate text-[11px] text-dls-secondary">{account.email}</div>
              ) : null}
              {serverLine ? (
                <div className="truncate text-[11px] text-dls-secondary" data-testid="account-server">
                  {serverLine}
                </div>
              ) : null}
              <div className="mt-0.5 text-[11px] text-dls-secondary">
                {accountMessage || (account.connected
                  ? account.usage
                    ? `${compactTokenCount(account.usage.remainingTokens)} of ${compactTokenCount(account.usage.tokenLimit)} tokens left today`
                    : "omnirush.ai models are ready on this Mac."
                  : account.gatewayConfigured
                    ? account.reauthorizationRequired
                      ? account.keyringUnavailable
                        ? "Your system keyring is not available right now. Sign in again to continue."
                        : "Your session expired. Sign in again to continue."
                      : "Sign in in your browser, then return here."
                    : "The omnirush.ai account service has not been configured for this build.")}
              </div>
              {account.connected && account.credentialStorage === "file" ? (
                <div className="mt-0.5 text-[11px] text-dls-secondary" data-testid="account-credential-storage">
                  Signed in. Your system has no keyring, so the sign-in is kept in a private file on this computer.
                </div>
              ) : null}
              {account.connected && account.usage?.tokenLimit ? (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-dls-hover" aria-label={`${account.usage.usedTokens} tokens used today`}>
                  <div
                    className="h-full rounded-full bg-[#b9f45a]"
                    style={{ width: `${Math.min(100, Math.max(0, (account.usage.usedTokens / account.usage.tokenLimit) * 100))}%` }}
                  />
                </div>
              ) : null}
            </div>
            {account.connected ? (
              <button type="button" disabled={accountBusy} onClick={() => void signOutAccount()} className="rounded-lg border border-dls-border px-3 py-2 text-[12px] text-dls-secondary hover:bg-dls-hover disabled:opacity-50">
                Sign out
              </button>
            ) : (
              <button type="button" disabled={accountBusy || !account.gatewayConfigured} onClick={() => void connectAccount()} className="rounded-lg bg-dls-text px-3 py-2 text-[12px] font-medium text-dls-background disabled:opacity-50">
                {accountBusy ? "Waiting…" : "Sign in"}
              </button>
            )}
          </div>
        </div>
      )}
      {/* Workspace settings */}
      <div className="space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
          Workspace
        </div>
        <div className="grid grid-cols-2 gap-2">
          {workspaceCards.map((card) => (
            <SettingsCard
              key={card.tab}
              icon={card.icon}
              title={cardTitle(card)}
              desc={cardDescription(card)}
              onClick={() => props.onNavigateTab(card.tab)}
            />
          ))}
        </div>
      </div>

      {/* Global settings */}
      <div className="space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
          Global
        </div>
        <div className="grid grid-cols-2 gap-2">
          {globalCards.map((card) => (
            <SettingsCard
              key={card.tab}
              icon={card.icon}
              title={cardTitle(card)}
              desc={cardDescription(card)}
              onClick={() => props.onNavigateTab(card.tab)}
            />
          ))}
        </div>
      </div>

      {approvalsClient ? (
        <ApprovalsCard
          approvals={approvalMode.approvals}
          busy={approvalMode.busy}
          status={approvalMode.status}
          onToggle={(enabled) => void approvalMode.setFullPermissions(enabled)}
        />
      ) : null}

      <DiagnosticsSection buildBundle={props.buildDiagnosticsBundle} />
    </div>
  );
}
