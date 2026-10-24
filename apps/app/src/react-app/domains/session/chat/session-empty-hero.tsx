/** @jsxImportSource react */
import { useProviderLock } from "@/app/lib/provider-lock";
import { useEffect, useState } from "react";
import { Zap } from "lucide-react";

import { t } from "@/i18n";

import type { ComposerAttachment } from "@/app/types";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { BuildathonPromoCard } from "@/react-app/domains/buildathon/buildathon-promo";
import { PlacementHomeCard } from "@/react-app/domains/placements/placements";
import { HomeContinue, type HomeViewContext } from "@/react-app/domains/session/home/home-recent";
import {
  NewTaskComposer,
  type NewTaskComposerContext,
  type NewTaskComposerHandoff,
} from "./new-task-composer";

type TimeGreeting = {
  title: string;
  subtitle: string;
};

export function greetingForLocalHour(hour: number): TimeGreeting {
  if (hour < 5) {
    return {
      title: t("home.greeting_night_title"),
      subtitle: t("home.greeting_night_subtitle"),
    };
  }

  if (hour < 12) {
    return {
      title: t("home.greeting_morning_title"),
      subtitle: t("home.greeting_subtitle"),
    };
  }

  if (hour < 17) {
    return {
      title: t("home.greeting_afternoon_title"),
      subtitle: t("home.greeting_afternoon_subtitle"),
    };
  }

  if (hour < 22) {
    return {
      title: t("home.greeting_evening_title"),
      subtitle: t("home.greeting_subtitle"),
    };
  }

  return {
    title: t("home.greeting_night_title"),
    subtitle: t("home.greeting_night_subtitle"),
  };
}

export type SessionEmptyHeroProps = {
  providerCount: number;
  /** Disable submission while a default workspace is being prepared. */
  busy?: boolean;
  /** Called with the task prompt and attachments; the caller creates the session (and workspace if needed). */
  onRunTask: (
    prompt: string,
    attachments: ComposerAttachment[],
    handoff?: NewTaskComposerHandoff,
  ) => void | Promise<void>;
  onOpenProviderAuth?: () => void;
  /** Workspace-scoped wiring for the full composer (skills, agents, models). */
  composer?: NewTaskComposerContext | null;
  /** Recent projects and chats, and the search of past chats (all local). */
  home?: HomeViewContext | null;
};

/**
 * Paper "first chat" empty state: the greeting and the real session composer
 * front and center, with one quiet "Continue … Search" line under it.
 */
export function SessionEmptyHero(props: SessionEmptyHeroProps) {
  const [prompt, setPrompt] = useState("");
  const [greeting] = useState(() => greetingForLocalHour(new Date().getHours()));
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const providerLock = useProviderLock();
  const canAddProviders = !providerLock.locked && !checkDesktopRestriction({ restriction: "allowCustomProviders" });

  const submit = (
    resolvedPrompt: string,
    attachments: ComposerAttachment[],
    handoff?: NewTaskComposerHandoff,
  ) => {
    const trimmedPrompt = resolvedPrompt.trim();
    if ((!trimmedPrompt && !attachments.length) || props.busy) return;
    return props.onRunTask(trimmedPrompt, attachments, handoff);
  };

  // The editor's "Ask about selection" / "Fix with agent" before any chat exists: appended to the draft.
  useEffect(() => {
    const onPrefill = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      if (typeof text !== "string" || !text) return;
      event.preventDefault();
      setPrompt((value) => (value.trim() ? `${value.replace(/\s+$/, "")}\n\n${text}` : text));
      window.setTimeout(() => window.dispatchEvent(new Event("omnirush:focusPrompt")), 50);
    };
    window.addEventListener("omnirush:new-task-prefill", onPrefill);
    return () => window.removeEventListener("omnirush:new-task-prefill", onPrefill);
  }, []);

  return (
    <div className="mx-auto w-full max-w-[640px] space-y-4 px-4 max-lg:px-4 sm:px-6">
      <div className="space-y-1.5 text-center">
        <h2 className="text-balance break-keep text-[24px] font-semibold leading-[30px] tracking-[-0.02em] text-foreground">
          {greeting.title}
        </h2>
        <p className="text-[13px] text-muted-foreground">{greeting.subtitle}</p>
      </div>

      <NewTaskComposer
        draft={prompt}
        onDraftChange={setPrompt}
        onRunTask={submit}
        busy={props.busy ?? false}
        context={props.composer ?? null}
      />

      {canAddProviders && props.providerCount === 0 && props.onOpenProviderAuth ? (
        <button
          type="button"
          className="flex w-full items-start gap-3 rounded-xl border border-blue-7/50 bg-blue-2/40 p-3.5 text-left transition-colors hover:bg-blue-3/50"
          onClick={props.onOpenProviderAuth}
        >
          <Zap className="mt-0.5 size-4 shrink-0 text-blue-10" />
          <div>
            <div className="text-[13px] font-medium text-foreground">{t("home.connect_provider_title")}</div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              {t("home.connect_provider_body")}
            </div>
          </div>
        </button>
      ) : null}

      {props.home ? <HomeContinue context={props.home} /> : null}

      <BuildathonPromoCard />

      <PlacementHomeCard />
    </div>
  );
}
