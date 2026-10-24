/** @jsxImportSource react */
import { useEffect, useState } from "react";
import {
  Code2,
  ArrowRight,
  Bot,
  Coffee,
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

import type { KeepAwakeState, OmniRushAccountSignOutReason } from "@omnirush/types/desktop-ipc";

import { Switch } from "@/components/ui/switch";
import { t } from "../../../../i18n";
import type { SettingsTab } from "../../../../app/types";
import {
  keepAwakeSet,
  keepAwakeStatus,
  omnirushAccountConnect,
  omnirushAccountSignOut,
  omnirushAccountStatus,
} from "../../../../app/lib/desktop";
import type { OmniRushApprovalMode, OmniRushRuntimeApprovals } from "../../../../app/lib/omnirush-server";
import { captureAnalyticsEvent, resetAnalyticsAccount, syncAnalyticsAccount } from "../../../../app/lib/analytics";
import { omnirushUsageSummary } from "../../../../app/lib/omnirush-usage";
import { ALLOWANCE_HELP_TITLE } from "../../../../app/lib/allowance-help";
import { AllowanceHelpLink } from "../../quality/allowance-help";
import { isElectronRuntime } from "../../../../app/utils";
import {
  APPROVAL_MODES,
  approvalModeLabel,
  approvalsEnvironmentHint,
  useApprovalMode,
  type ApprovalsClient,
} from "../approval-mode";
import { DiagnosticsSection } from "./diagnostics-section";
import { FreeSpaceSection } from "./free-space-section";
import { keptPendingLine, sendPendingBeforeSignOut } from "../sign-out-uploads";
import { useBestPractices, type BestPracticesClient } from "../best-practices";
import { AGENT_ASSIST_ITEMS, useAgentAssist, type AgentAssistClient } from "../agent-assist";
import type { OmniRushAgentAssist, OmniRushAgentAssistFeature } from "../../../../app/lib/omnirush-server";
import { useLinuxSandbox, type LinuxSandboxClient } from "../linux-sandbox";
import { LinuxSandboxCard } from "../linux-sandbox-card";
import { BuildathonTrackCard } from "../../buildathon/buildathon";

export type GeneralSettingsViewProps = {
  onNavigateTab: (tab: SettingsTab) => void;
  developerMode: boolean;
  /** Server client for the Approvals card; the card is hidden without one. */
  omnirushClient?: ApprovalsClient | null;
  /** Global guides do not depend on workspace selection or history loading. */
  bestPracticesClient?: BestPracticesClient | null;
  /** Agent assist switches (self-check, project notes, diagnostics, summaries); hidden without one. */
  agentAssistClient?: AgentAssistClient | null;
  /** Workspace whose engine is reloaded after the approval mode changes. */
  runtimeWorkspaceId?: string | null;
  /** The Linux sandbox card (per project); hidden without a client or a selected workspace. */
  linuxSandboxClient?: LinuxSandboxClient | null;
  sandboxWorkspaceId?: string | null;
  /** The selected local project, for its buildathon track (shown to enrolled accounts only). */
  buildathonProject?: { path: string; name: string } | null;
  /** Builds the sanitized diagnostics bundle with the route's context. */
  buildDiagnosticsBundle?: () => Promise<string>;
};

type NativeAccountStatus = Awaited<ReturnType<typeof omnirushAccountStatus>>;

type SettingsCardDefinition = { tab: SettingsTab; icon: typeof Sparkles } & (
  | { title: string; desc: string }
  | { titleKey: string; descKey: string }
);

const workspaceCards: SettingsCardDefinition[] = [
  { tab: "preferences", icon: Cog, titleKey: "settings.tab_preferences", descKey: "settings.card_preferences_desc" },
  { tab: "permissions", icon: FolderLock, titleKey: "settings.tab_permissions", descKey: "settings.card_permissions_desc" },
  { tab: "advanced", icon: Wrench, titleKey: "settings.tab_advanced", descKey: "settings.card_advanced_desc" },
];

const globalCards: SettingsCardDefinition[] = [
  { tab: "ai", icon: Sparkles, titleKey: "settings.tab_ai", descKey: "settings.card_ai_desc" },
  { tab: "appearance", icon: Paintbrush, titleKey: "settings.tab_appearance", descKey: "settings.card_appearance_desc" },
  { tab: "editor", icon: Code2, titleKey: "settings.tab_editor", descKey: "settings.card_editor_desc" },
  { tab: "voice", icon: Mic, titleKey: "settings.tab_voice", descKey: "settings.card_voice_desc" },
  { tab: "environment", icon: Terminal, titleKey: "settings.tab_environment", descKey: "settings.card_environment_desc" },
  { tab: "updates", icon: RefreshCcw, titleKey: "settings.tab_updates", descKey: "settings.card_updates_desc" },
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
  const host = server?.trim() || t("settings.account_server_fallback");
  switch (outcome.reason) {
    case "revoked":
      return t("settings.signout_revoked", { host });
    case "already_revoked":
      return t("settings.signout_already_revoked", { host });
    case "endpoint_missing":
      return t("settings.signout_endpoint_missing", { host });
    case "unreachable":
      return t("settings.signout_unreachable", { host });
    default:
      return outcome.remoteRevoked
        ? t("settings.signout_revoked", { host })
        : t("settings.signout_not_revoked", { host });
  }
}

/** Names the account server the app is connected to, or will connect to on sign-in. */
export function accountServerLine(account: Pick<NativeAccountStatus, "connected" | "gatewayHost">): string | null {
  const host = account.gatewayHost?.trim();
  if (!host) return null;
  return account.connected ? t("settings.account_connected_to", { host }) : t("settings.account_server", { host });
}

/**
 * Settings > General > Permissions: Careful / Normal / Auto. The mode, busy
 * flag and status come from useApprovalMode, which the composer's permissions
 * menu shares.
 */
export function ApprovalsCard(props: {
  approvals: OmniRushRuntimeApprovals | null;
  busy: boolean;
  status: string;
  onSelect: (mode: OmniRushApprovalMode) => void;
  /** Set when the organisation's policy does not allow changing app settings. */
  policyLocked?: boolean;
}) {
  const hint = props.policyLocked
    ? t("permissions.policy_lock")
    : props.approvals ? approvalsEnvironmentHint(props.approvals) : null;
  const current = props.approvals?.mode ?? null;
  const disabled = props.busy || !props.approvals || hint !== null;
  const summary = current ? approvalModeLabel(current).summary : t("permissions.card_desc");
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
        {t("permissions.title")}
      </div>
      <div className="flex items-start gap-4 rounded-2xl border border-dls-border bg-dls-surface p-4" data-testid="approvals-card">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
          <ShieldCheck size={17} className={current === "full" ? "text-amber-400" : "text-dls-secondary"} />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <div className="text-[13px] font-medium text-dls-text">{t("permissions.card_desc")}</div>
            <div className="text-[11px] text-dls-secondary" id="approval-mode-summary" data-testid="approval-mode-summary">{summary}</div>
          </div>
          <div
            role="radiogroup"
            aria-label={t("permissions.title")}
            aria-describedby="approval-mode-summary"
            aria-disabled={disabled || undefined}
            className="inline-flex rounded-lg border border-dls-border bg-dls-hover p-0.5"
          >
            {APPROVAL_MODES.map((mode) => {
              const selected = current === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  data-testid={`approval-mode-${mode}`}
                  onClick={() => {
                    if (!selected) props.onSelect(mode);
                  }}
                  className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed ${
                    selected
                      ? mode === "full"
                        ? "bg-dls-surface text-[color:var(--omnirush-warn,var(--orange-11))] shadow-sm"
                        : "bg-dls-surface text-dls-text shadow-sm"
                      : "text-dls-secondary hover:text-dls-text disabled:hover:text-dls-secondary"
                  } ${disabled && !selected ? "opacity-60" : ""}`}
                >
                  {approvalModeLabel(mode).title}
                </button>
              );
            })}
          </div>
          {hint ? (
            <div className="text-[11px] text-dls-secondary" data-testid="approvals-env-hint">{hint}</div>
          ) : null}
          {props.status ? (
            <div className="text-[11px] text-dls-secondary" role="status" data-testid="approvals-status">{props.status}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function BestPracticesCard(props: {
  enabled: boolean | null;
  busy: boolean;
  status: string;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">{t("settings.best_practices_title")}</div>
      <div className="flex items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
          <Sparkles size={17} className="text-dls-secondary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-dls-text">{t("settings.best_practices_title")}</div>
          <div id="best-practices-help" className="text-[11px] text-dls-secondary">{t("settings.best_practices_help")}</div>
          {props.status ? (
            <div className="mt-0.5 text-[11px] text-dls-secondary" role="status" data-testid="best-practices-status">{props.status}</div>
          ) : null}
        </div>
        <Switch
          aria-label={t("settings.best_practices_title")}
          aria-describedby="best-practices-help"
          checked={props.enabled === true}
          disabled={props.busy || props.enabled === null}
          onCheckedChange={props.onToggle}
        />
      </div>
    </div>
  );
}

function agentAssistText(key: OmniRushAgentAssistFeature): { title: string; help: string } {
  switch (key) {
    case "selfCheck":
      return { title: t("settings.agent_assist.selfCheck_title"), help: t("settings.agent_assist.selfCheck_help") };
    case "projectNotes":
      return { title: t("settings.agent_assist.projectNotes_title"), help: t("settings.agent_assist.projectNotes_help") };
    case "diagnostics":
      return { title: t("settings.agent_assist.diagnostics_title"), help: t("settings.agent_assist.diagnostics_help") };
    case "compaction":
      return { title: t("settings.agent_assist.compaction_title"), help: t("settings.agent_assist.compaction_help") };
  }
}

/** Settings > General > Agent: what the agent does on its own (agent-assist-config.ts on the server). */
export function AgentAssistCard(props: {
  setting: OmniRushAgentAssist | null;
  busy: boolean;
  status: string;
  onToggle: (key: OmniRushAgentAssistFeature, enabled: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">{t("composer.agent_label")}</div>
      <div className="rounded-2xl border border-dls-border bg-dls-surface" data-testid="agent-assist-card">
        {AGENT_ASSIST_ITEMS.map((item, index) => {
          const forced = props.setting?.forced.includes(item.key) ?? false;
          return (
            <div key={item.key} className={`flex items-center gap-4 p-4${index > 0 ? " border-t border-dls-border" : ""}`}>
              {index === 0 ? (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
                  <Bot size={17} className="text-dls-secondary" />
                </div>
              ) : (
                <div className="h-10 w-10 shrink-0" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-dls-text">{agentAssistText(item.key).title}</div>
                <div id={`agent-assist-${item.key}-help`} className="text-[11px] text-dls-secondary">
                  {agentAssistText(item.key).help}
                  {forced ? ` ${t("settings.agent_assist.forced")}` : ""}
                </div>
              </div>
              <Switch
                aria-label={agentAssistText(item.key).title}
                aria-describedby={`agent-assist-${item.key}-help`}
                checked={props.setting?.features[item.key] === true}
                disabled={props.busy || props.setting === null || forced}
                onCheckedChange={(enabled) => props.onToggle(item.key, enabled)}
              />
            </div>
          );
        })}
      </div>
      {props.status ? (
        <div className="text-[11px] text-dls-secondary" role="status" data-testid="agent-assist-status">{props.status}</div>
      ) : null}
    </div>
  );
}

export const KEEP_AWAKE_TITLE = "Keep this computer awake while the agent works";
export const KEEP_AWAKE_HELP = "Your computer won't go to sleep while a turn runs, or while the app finishes up as it quits. The screen can still turn off and lock.";

/** Settings > General > Keep awake: a desktop setting (keep-awake.mjs), on by default. */
export function KeepAwakeCard(props: {
  state: KeepAwakeState | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const hint = props.state?.forcedOff
    ? t("settings.keep_awake_forced_off")
    : props.state && !props.state.available
      ? t("settings.keep_awake_unavailable")
      : null;
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">{t("settings.power_title")}</div>
      <div className="flex items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
          <Coffee size={17} className="text-dls-secondary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-dls-text">{t("settings.keep_awake_title")}</div>
          <div id="keep-awake-help" className="text-[11px] text-dls-secondary">{t("settings.keep_awake_help")}</div>
          {hint ? (
            <div className="mt-0.5 text-[11px] text-dls-secondary" role="status" data-testid="keep-awake-status">{hint}</div>
          ) : null}
        </div>
        <Switch
          aria-label={t("settings.keep_awake_title")}
          aria-describedby="keep-awake-help"
          checked={props.state?.enabled === true}
          disabled={props.busy || props.state === null}
          onCheckedChange={props.onToggle}
        />
      </div>
    </div>
  );
}

function useKeepAwake() {
  const [state, setState] = useState<KeepAwakeState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isElectronRuntime()) return;
    void keepAwakeStatus().then(setState).catch(() => setState(null));
  }, []);
  async function setEnabled(enabled: boolean) {
    setBusy(true);
    try {
      setState(await keepAwakeSet(enabled));
    } catch {
      setState(await keepAwakeStatus().catch(() => null));
    } finally {
      setBusy(false);
    }
  }
  return { state, busy, setEnabled };
}

export function GeneralSettingsView(props: GeneralSettingsViewProps) {
  const [account, setAccount] = useState<NativeAccountStatus | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountMessage, setAccountMessage] = useState("");
  const approvalsClient = props.omnirushClient ?? null;
  const approvalMode = useApprovalMode(approvalsClient, props.runtimeWorkspaceId ?? null);
  const bestPracticesClient = props.bestPracticesClient ?? null;
  const bestPractices = useBestPractices(bestPracticesClient);
  const agentAssistClient = props.agentAssistClient ?? null;
  const agentAssist = useAgentAssist(agentAssistClient);
  const linuxSandboxClient = props.linuxSandboxClient ?? null;
  const linuxSandbox = useLinuxSandbox(linuxSandboxClient, props.sandboxWorkspaceId ?? null);
  const keepAwake = useKeepAwake();

  useEffect(() => {
    if (!isElectronRuntime()) return;
    void omnirushAccountStatus().then((next) => {
      setAccount(next);
      syncAnalyticsAccount(next);
    }).catch(() => setAccount({ connected: false, gatewayConfigured: false }));
  }, []);

  async function connectAccount() {
    setAccountBusy(true);
    setAccountMessage(t("settings.account_approve_in_browser"));
    try {
      await omnirushAccountConnect();
      captureAnalyticsEvent("device_approved", { method: "device_link" });
      const next = await omnirushAccountStatus();
      setAccount(next);
      if (next.connected) {
        // Identify first so the sign-in itself is linked to the account.
        syncAnalyticsAccount(next);
        captureAnalyticsEvent("sign_in_completed", { method: "device_link" });
      }
      setAccountMessage(t("settings.account_connected_ready"));
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : t("settings.account_connect_failed"));
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
      // What is still queued goes first (a few seconds at most); the rest stays on this computer for this account.
      const kept = account?.connected ? await sendPendingBeforeSignOut(setAccountMessage) : 0;
      const result = await omnirushAccountSignOut();
      resetAnalyticsAccount();
      const next = await omnirushAccountStatus().catch(() => null);
      setAccount(next ?? { connected: false, gatewayConfigured: account?.gatewayConfigured ?? false });
      setAccountMessage(kept > 0 ? `${accountSignOutMessage(result, server)} ${keptPendingLine(kept)}` : accountSignOutMessage(result, server));
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : t("settings.account_sign_out_failed"));
    } finally {
      setAccountBusy(false);
    }
  }

  const serverLine = account ? accountServerLine(account) : null;
  const usage = account?.connected && account.usage ? omnirushUsageSummary(account.usage) : null;

  return (
    <div className="w-full max-w-3xl space-y-8">
      {isElectronRuntime() && account && (
        <div className="space-y-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
            {t("settings.tab_cloud_account")}
          </div>
          <div className="flex items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
              <UserRoundCheck size={17} className={account.connected ? "text-emerald-400" : "text-dls-secondary"} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-dls-text">
                {account.connected ? account.displayName || account.email || t("config.status_connected") : t("settings.account_sign_in_title")}
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
                  ? usage
                    ? usage.line
                    : t("settings.account_models_ready")
                  : account.gatewayConfigured
                    ? account.reauthorizationRequired
                      ? account.keyringUnavailable
                        ? t("settings.account_keyring_unavailable")
                        : t("settings.account_session_expired")
                      : t("settings.account_sign_in_hint")
                    : t("settings.account_not_configured"))}
              </div>
              {account.connected && account.credentialStorage === "file" ? (
                <div className="mt-0.5 text-[11px] text-dls-secondary" data-testid="account-credential-storage">
                  {t("settings.account_file_storage")}
                </div>
              ) : null}
              {usage ? (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-dls-hover" aria-label={t("settings.account_usage_percent", { percent: Math.round(usage.percent) })}>
                  <div
                    className="h-full rounded-full bg-highlight"
                    style={{ width: `${usage.percent}%` }}
                  />
                </div>
              ) : null}
              {usage ? (
                <AllowanceHelpLink className="mt-1.5 text-[11px] text-dls-secondary" label={ALLOWANCE_HELP_TITLE} testId="account-allowance-help" />
              ) : null}
            </div>
            {account.connected ? (
              <button type="button" disabled={accountBusy} onClick={() => void signOutAccount()} className="rounded-lg border border-dls-border px-3 py-2 text-[12px] text-dls-secondary hover:bg-dls-hover disabled:opacity-50">
                {t("den.sign_out")}
              </button>
            ) : (
              <button type="button" disabled={accountBusy || !account.gatewayConfigured} onClick={() => void connectAccount()} className="rounded-lg bg-dls-text px-3 py-2 text-[12px] font-medium text-dls-background disabled:opacity-50">
                {accountBusy ? t("settings.account_waiting") : t("settings.account_sign_in")}
              </button>
            )}
          </div>
        </div>
      )}
      {/* Workspace settings */}
      <div className="space-y-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
          {t("settings.section_workspace")}
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
          {t("settings.section_global")}
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
          onSelect={(mode) => void approvalMode.setApprovalMode(mode)}
        />
      ) : null}

      {bestPracticesClient ? (
        <BestPracticesCard
          enabled={bestPractices.setting?.enabled ?? null}
          busy={bestPractices.busy}
          status={bestPractices.status}
          onToggle={(enabled) => void bestPractices.setEnabled(enabled)}
        />
      ) : null}

      {agentAssistClient ? (
        <AgentAssistCard
          setting={agentAssist.setting}
          busy={agentAssist.busy}
          status={agentAssist.status}
          onToggle={(key, enabled) => void agentAssist.setFeature(key, enabled)}
        />
      ) : null}

      {isElectronRuntime() ? (
        <KeepAwakeCard
          state={keepAwake.state}
          busy={keepAwake.busy}
          onToggle={(enabled) => void keepAwake.setEnabled(enabled)}
        />
      ) : null}

      {props.buildathonProject ? (
        <BuildathonTrackCard projectPath={props.buildathonProject.path} projectName={props.buildathonProject.name} />
      ) : null}

      {linuxSandboxClient && props.sandboxWorkspaceId ? (
        <LinuxSandboxCard
          box={linuxSandbox.box}
          pending={linuxSandbox.pending}
          problem={linuxSandbox.problem}
          notice={linuxSandbox.notice}
          onToggle={(enabled) => void linuxSandbox.setEnabled(enabled)}
          onRetry={() => void linuxSandbox.retry()}
          onReset={() => void linuxSandbox.reset()}
          onBackend={(backend) => void linuxSandbox.setBackend(backend)}
        />
      ) : null}

      <FreeSpaceSection />

      <DiagnosticsSection buildBundle={props.buildDiagnosticsBundle} />
    </div>
  );
}
