/** @jsxImportSource react */
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Cog,
  FolderLock,
  Paintbrush,
  RefreshCcw,
  Sparkles,
  Terminal,
  Wrench,
  UserRoundCheck,
} from "lucide-react";

import { t } from "../../../../i18n";
import type { SettingsTab } from "../../../../app/types";
import {
  omnirushAccountConnect,
  omnirushAccountSignOut,
  omnirushAccountStatus,
} from "../../../../app/lib/desktop";
import { isElectronRuntime } from "../../../../app/utils";

export type GeneralSettingsViewProps = {
  onNavigateTab: (tab: SettingsTab) => void;
  developerMode: boolean;
};

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

export function GeneralSettingsView(props: GeneralSettingsViewProps) {
  const [account, setAccount] = useState<{ connected: boolean; gatewayConfigured: boolean } | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountMessage, setAccountMessage] = useState("");

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
      setAccountMessage("Account connected. Astra routing is ready.");
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "The account could not be connected.");
    } finally {
      setAccountBusy(false);
    }
  }

  async function signOutAccount() {
    setAccountBusy(true);
    try {
      await omnirushAccountSignOut();
      setAccount({ connected: false, gatewayConfigured: account?.gatewayConfigured ?? false });
      setAccountMessage("Signed out on this Mac.");
    } finally {
      setAccountBusy(false);
    }
  }

  return (
    <div className="w-full max-w-3xl space-y-8">
      {isElectronRuntime() && account && (
        <div className="space-y-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
            OmniRush account
          </div>
          <div className="flex items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover">
              <UserRoundCheck size={17} className={account.connected ? "text-emerald-400" : "text-dls-secondary"} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-dls-text">
                {account.connected ? "Connected" : "Connect your account"}
              </div>
              <div className="text-[11px] text-dls-secondary">
                {accountMessage || (account.connected
                  ? "Secure model access and usage are linked to this Mac."
                  : account.gatewayConfigured
                    ? "Sign in in your browser, then return here."
                    : "The OmniRush account service has not been configured for this build.")}
              </div>
            </div>
            {account.connected ? (
              <button type="button" disabled={accountBusy} onClick={() => void signOutAccount()} className="rounded-lg border border-dls-border px-3 py-2 text-[12px] text-dls-secondary hover:bg-dls-hover disabled:opacity-50">
                Sign out
              </button>
            ) : (
              <button type="button" disabled={accountBusy || !account.gatewayConfigured} onClick={() => void connectAccount()} className="rounded-lg bg-dls-text px-3 py-2 text-[12px] font-medium text-dls-bg disabled:opacity-50">
                {accountBusy ? "Waiting…" : "Connect"}
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

    </div>
  );
}
