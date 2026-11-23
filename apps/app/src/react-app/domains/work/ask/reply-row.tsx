/** @jsxImportSource react */
// The chips under the newest answer in a Work chat (design 3.5): fixes the app knows about first, then the replies the
// agent offered. The transcript renders <WorkReplySlot /> in its last finished group; the chat surface decides through
// the context whether anything shows (a Work chat, idle, nothing to approve or answer, no items attached), so a Code
// chat, which has no provider, never shows a row.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { Play, RotateCcw } from "lucide-react";

import type { OmniRushWorkConnector, OmniRushWorkSettings, OmniRushWorkState } from "@/app/lib/omnirush-server";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { usePlatform } from "@/react-app/kernel/platform";

import { ConnectorIcon } from "../brand-icon";
import {
  connectorLabel,
  connectorsBackState,
  signsInWithForm,
  WORK_CONNECTORS_ROUTE,
  workConnectorsKey,
  workFailure,
  workSettingsKey,
  workStateKey,
  type WorkClient,
} from "../work-mode";
import { actionChipSpecs, NO_SIGNALS, type ActionChipSpec, type TurnSignals } from "./action-chips";
import { SuggestionChipRow, type SuggestionChip } from "./suggestion-chips";

export type WorkRepliesValue = {
  /** Every condition but the group's place: a Work chat, idle, nothing pending, no items attached, no error. */
  show: boolean;
  replies: string[];
  signals: TurnSignals;
  client: WorkClient | null;
  /** Sends the text at once (a chat command: the composer and its chips are left alone). */
  onSend: (text: string) => void;
  /** Puts the text in the composer and focuses it; sends nothing. */
  onFill: (text: string) => void;
  busy?: boolean;
};

export const WorkRepliesContext = createContext<WorkRepliesValue | null>(null);

const EMPTY: WorkRepliesValue = { show: false, replies: [], signals: NO_SIGNALS, client: null, onSend: () => {}, onFill: () => {} };

/** The newest answer's row (rendered by the transcript's last finished group); nothing outside a Work chat. */
export function WorkReplySlot() {
  const value = useContext(WorkRepliesContext) ?? EMPTY;
  if (!value.show || (!value.replies.length && !value.signals.errors.length && !value.signals.notices)) return null;
  return <WorkReplyRow value={value} />;
}

/** The time, every second until `until` (a wait's end) has passed; still once it has. */
function useNow(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  const waiting = Boolean(until && until > now);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waiting]);
  return now;
}

/** A query's cached data, kept current, without adding a query to the cache while rendering (the effect reads it). */
function useCachedData<T>(queryKey: QueryKey): T | undefined {
  const queryClient = useQueryClient();
  const hash = JSON.stringify(queryKey);
  const subscribe = useCallback((listener: () => void) => queryClient.getQueryCache().subscribe(listener), [queryClient]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const read = useCallback(() => queryClient.getQueryData<T>(queryKey), [queryClient, hash]);
  return useSyncExternalStore(subscribe, read, read);
}

function WorkReplyRow({ value }: { value: WorkRepliesValue }) {
  const { signals, client } = value;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const platform = usePlatform();
  const needsConnectors = signals.notices || signals.errors.some((error) => error.code === "reconnect_required");
  const needsSettings = signals.errors.some((error) => error.code === "writes_paused");
  const connectors = useCachedData<OmniRushWorkConnector[]>(workConnectorsKey(client));
  const settings = useCachedData<OmniRushWorkSettings>(workSettingsKey(client));
  const state = useCachedData<OmniRushWorkState>(workStateKey(client));
  // A turn that hit a reconnect, carried a notice or found actions paused reads the live state again once, so a fixed
  // connector or resumed actions get no stale chip.
  const turnKey = signals.errors.map((error) => `${error.tool}:${error.code}:${error.at ?? ""}`).join("|") + (signals.notices ? "|n" : "");
  const refetched = useRef<string | null>(null);
  useEffect(() => {
    if (!client || (!needsConnectors && !needsSettings) || refetched.current === turnKey) return;
    refetched.current = turnKey;
    if (needsConnectors) void queryClient.fetchQuery({ queryKey: workConnectorsKey(client), queryFn: () => client.listWorkConnectors() }).catch(() => undefined);
    if (needsSettings) void queryClient.fetchQuery({ queryKey: workSettingsKey(client), queryFn: () => client.getWorkSettings() }).catch(() => undefined);
  }, [client, needsConnectors, needsSettings, queryClient, turnKey]);

  const writesPaused = settings?.writes_paused ?? state?.writes_paused;
  const specs = useMemo(() => actionChipSpecs(signals, { connectors, writesPaused }), [connectors, signals, writesPaused]);
  const readyAt = specs.reduce<number | null>((at, spec) => (spec.kind === "retry" && spec.readyAt ? Math.max(at ?? 0, spec.readyAt) : at), null);
  const now = useNow(readyAt);

  const setPaused = async (paused: boolean) => {
    const answer = await client!.setWorkSettings({ writes_paused: paused });
    queryClient.setQueryData(workSettingsKey(client), answer);
    queryClient.setQueryData<OmniRushWorkState | undefined>(workStateKey(client), (state) => (state ? { ...state, writes_paused: answer.writes_paused } : state));
    return answer;
  };
  const failed = (reason: unknown) => { toast.error(workFailure(reason).text); };

  const actionChip = (spec: ActionChipSpec): SuggestionChip | null => {
    // The short name the app knows ("Google"), else the server's label for the connector.
    const name = (id: string, label?: string | null) => {
      const known = connectorLabel(id);
      return known !== id ? known : connectorLabel(id, label ?? connectors?.find((row) => row.id === id)?.label);
    };
    const openConnectors = (id: string) => navigate(`${WORK_CONNECTORS_ROUTE}#${encodeURIComponent(id)}`, connectorsBackState(location.pathname, location.search));
    switch (spec.kind) {
      case "link": {
        const label = spec.code === "needs_install"
          ? spec.owner ? t("work.replies.install_on", { owner: spec.owner }) : t("work.replies.install_github")
          : spec.code === "repo_not_installed" && spec.repo ? t("work.replies.add_repo", { repo: spec.repo }) : t("work.replies.review_access");
        return { id: spec.id, label, tone: "action", external: true, icon: <ConnectorIcon id="github" />, onRun: () => platform.openLink(spec.url) };
      }
      case "reconnect":
        return {
          id: spec.id,
          label: t("work.replies.reconnect", { name: name(spec.connector, spec.label) }),
          tone: "action",
          icon: <ConnectorIcon id={spec.connector} />,
          onRun: async () => {
            if (!client) return;
            if (signsInWithForm(connectors, spec.connector)) return openConnectors(spec.connector);
            try {
              const answer = await client.startWorkConnector(spec.connector);
              platform.openLink(answer.auth_url);
            } catch (reason) {
              failed(reason);
            }
          },
        };
      case "connect":
      case "connectors":
        return {
          id: spec.id,
          label: t(spec.kind === "connect" ? "work.replies.connect" : "work.replies.open_connectors", { name: name(spec.connector) }),
          tone: "action",
          icon: <ConnectorIcon id={spec.connector} />,
          onRun: () => openConnectors(spec.connector),
        };
      case "resume":
        return {
          id: spec.id,
          label: t("work.replies.resume"),
          tone: "action",
          icon: <Play aria-hidden />,
          onRun: async () => {
            if (!client) return;
            try {
              await setPaused(false);
              toast.success(t("work.replies.resumed"), {
                action: { label: t("work.replies.pause_again"), onClick: () => { void setPaused(true).catch(failed); } },
              });
            } catch (reason) {
              failed(reason);
            }
          },
        };
      case "retry": {
        const wait = spec.readyAt && spec.readyAt > now ? Math.ceil((spec.readyAt - now) / 1000) : 0;
        const words = t("work.replies.try_again");
        return {
          id: spec.id,
          label: words,
          tone: "action",
          icon: <RotateCcw aria-hidden />,
          ...(wait ? { disabledReason: t("work.replies.wait", { seconds: wait }) } : {}),
          onRun: () => value.onSend(words),
        };
      }
    }
  };

  const chips: SuggestionChip[] = [
    ...specs.flatMap((spec) => actionChip(spec) ?? []),
    ...value.replies.map((reply, index) => ({ id: `reply:${index}:${reply}`, label: reply })),
  ];
  if (!chips.length) return null;
  return (
    <div className="mx-auto flex w-full max-w-3xl px-2 pt-1 @min-[40rem]/chatpane:px-10" data-testid="work-replies">
      <SuggestionChipRow
        chips={chips}
        max={4}
        label={t("work.replies.label")}
        onSend={value.onSend}
        onFill={value.onFill}
        busy={value.busy}
        shortcuts
        testId="work-reply-chips"
      />
    </div>
  );
}
