/** @jsxImportSource react */
import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";

import { t } from "@/i18n";
import { isDirectModelProvider, isInternalModelProvider } from "@/app/lib/provider-catalog";
import { isCloudManagedProviderKey } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { SettingsNotice, SettingsStatusBadge } from "../settings-section";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemFootnote,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";

type ConnectedProvider = {
  id: string;
  name: string;
  source?: "env" | "api" | "config" | "custom";
};

export type AiSettingsViewProps = {
  busy: boolean;
  providerAuthBusy: boolean;
  providerStatusLabel: string;
  providerStatusStyle: string;
  providerSummary: string;
  connectedProviders: ConnectedProvider[];
  disconnectingProviderId: string | null;
  providerConnectError: string | null;
  providerDisconnectStatus: string | null;
  providerDisconnectError: string | null;
  onOpenProviderAuth: () => void | Promise<void>;
  onDisconnectProvider: (providerId: string) => void | Promise<void>;
  canDisconnectProvider: (provider: ConnectedProvider) => boolean;
  canAddProviders: boolean;
  organizationName?: string;
  /** Set of local provider IDs that were imported from cloud. */
  cloudProviderIds?: Set<string>;
};

function providerSourceLabel(source?: ConnectedProvider["source"]) {
  if (source === "env") return t("settings.provider_source_env");
  if (source === "api") return t("settings.provider_source_api");
  if (source === "config") return t("settings.provider_source_config");
  if (source === "custom") return t("settings.provider_source_config");
  return null;
}

function providerSourceBadgeClassName(input: { orgManaged: boolean; source?: ConnectedProvider["source"] }) {
  if (input.orgManaged) {
    return "shrink-0 rounded-full border border-blue-6 bg-blue-2 px-2 py-0.5 text-[10px] font-medium text-blue-11";
  }
  if (input.source === "env") {
    return "shrink-0 rounded-full border border-amber-6 bg-amber-2 px-2 py-0.5 text-[10px] font-medium text-amber-11";
  }
  return "shrink-0 rounded-full border border-dls-border bg-dls-sidebar/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground";
}

function providerStatusTone(label: string): "ready" | "warning" | "neutral" {
  if (label.toLowerCase().includes("connected")) return "ready";
  if (label.toLowerCase().includes("error") || label.toLowerCase().includes("fail")) return "warning";
  return "neutral";
}

export function AiSettingsView(props: AiSettingsViewProps) {
  const organizationProviderLabel = props.organizationName?.trim() || t("settings.provider_source_organization");
  const internalModelsReady = props.connectedProviders.some((provider) => isInternalModelProvider(provider.id));
  const externalProviderCount = props.connectedProviders.filter((provider) => isDirectModelProvider(provider.id)).length;

  return (
    <LayoutStack>
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>Choose how models run</LayoutSectionTitle>
          <LayoutSectionDescription>
            Use the OmniRush.ai internal proxy or connect a major AI provider. Model names are always shown exactly as reported by their provider.
          </LayoutSectionDescription>
        </LayoutSectionHeader>

        <div className="grid gap-3 lg:grid-cols-2">
          <ModelAccessCard
            icon={<ShieldCheck className="size-4" />}
            title="Internal models"
            description="Use the OmniRush.ai inference proxy and models managed by your organization."
            status={internalModelsReady ? "Ready" : "Unavailable"}
            tone={internalModelsReady ? "ready" : "neutral"}
          />
          <ModelAccessCard
            icon={<KeyRound className="size-4" />}
            title="Provider connections"
            description="Connect OpenAI, Anthropic, Google, or OpenRouter without changing model identities."
            status={externalProviderCount > 0 ? `${externalProviderCount} connected` : "Optional"}
            tone={externalProviderCount > 0 ? "ready" : "neutral"}
            action={props.canAddProviders ? (
              <Button variant="outline" size="sm" onClick={() => void props.onOpenProviderAuth()}>
                Connect
              </Button>
            ) : null}
          />
        </div>
      </LayoutSection>

      {/* ---- Providers ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.providers_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.providers_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>
              {props.providerSummary}
              <SettingsStatusBadge
                tone={providerStatusTone(props.providerStatusLabel)}
                label={props.providerStatusLabel}
              />
            </LayoutSectionItemTitle>
            {props.canAddProviders ? (
              <LayoutSectionItemHeaderActions>
                <Button
                  onClick={() => void props.onOpenProviderAuth()}
                  disabled={props.busy || props.providerAuthBusy}
                >
                  {props.providerAuthBusy
                    ? t("settings.loading_providers")
                    : t("settings.connect_provider")}
                </Button>
              </LayoutSectionItemHeaderActions>
            ) : null}
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        {props.connectedProviders.length > 0 ? (
          <div className="space-y-2">
            {props.connectedProviders.map((provider) => {
              const orgManaged = isCloudManagedProviderKey(provider.id);
              const managedByCloud = orgManaged || props.cloudProviderIds?.has(provider.id) === true;
              const sourceLabel = orgManaged
                ? organizationProviderLabel
                : providerSourceLabel(provider.source);
              return (
                <LayoutSectionItem
                  key={provider.id}
                  className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <ProviderIcon providerId={provider.id} size={20} className="text-dls-text" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-dls-text">{provider.name}</span>
                        {sourceLabel ? (
                          <span className={providerSourceBadgeClassName({ orgManaged, source: provider.source })}>
                            {sourceLabel}
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate font-mono text-xs text-muted-foreground">{provider.id}</div>
                    </div>
                  </div>
                  {!managedByCloud ? (
                    <Button
                      variant="destructive"
                      onClick={() => void props.onDisconnectProvider(provider.id)}
                      disabled={
                        props.busy ||
                        props.providerAuthBusy ||
                        props.disconnectingProviderId !== null ||
                        !props.canDisconnectProvider(provider)
                      }
                    >
                      {props.disconnectingProviderId === provider.id
                        ? t("settings.disconnecting")
                        : props.canDisconnectProvider(provider)
                          ? t("settings.disconnect")
                          : t("settings.managed_by_env")}
                    </Button>
                  ) : null}
                </LayoutSectionItem>
              );
            })}
          </div>
        ) : null}

        {props.providerConnectError ? (
          <SettingsNotice tone="error">{props.providerConnectError}</SettingsNotice>
        ) : null}
        {props.providerDisconnectStatus ? (
          <SettingsNotice>{props.providerDisconnectStatus}</SettingsNotice>
        ) : null}
        {props.providerDisconnectError ? (
          <SettingsNotice tone="error">{props.providerDisconnectError}</SettingsNotice>
        ) : null}

        <LayoutSectionItemFootnote>
          API keys are stored locally on this device. Environment-backed providers must be changed in the worker environment and then reloaded.
        </LayoutSectionItemFootnote>
      </LayoutSection>

    </LayoutStack>
  );
}

function ModelAccessCard(props: {
  icon: ReactNode;
  title: string;
  description: string;
  status: string;
  tone: "ready" | "warning" | "neutral";
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-44 flex-col rounded-2xl border border-dls-border bg-dls-sidebar/20 p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex size-8 items-center justify-center rounded-xl bg-dls-hover text-dls-text">
          {props.icon}
        </span>
        <SettingsStatusBadge tone={props.tone} label={props.status} />
      </div>
      <div className="mt-3 text-sm font-semibold text-dls-text">{props.title}</div>
      <p className="mt-1 flex-1 text-xs leading-5 text-muted-foreground">{props.description}</p>
      {props.action ? <div className="mt-3">{props.action}</div> : null}
    </div>
  );
}
