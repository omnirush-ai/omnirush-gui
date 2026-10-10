/** @jsxImportSource react */
import { useState } from "react";
import { Zap } from "lucide-react";

import type { ComposerAttachment } from "@/app/types";
import { CODING_STARTER_CARDS, resolveOrganizationPromptCardContent } from "@/components/chat/task-suggestions";
import { useCheckDesktopRestriction, useOrgRestrictions } from "@/react-app/domains/cloud/desktop-config-provider";
import {
  NewTaskComposer,
  type NewTaskComposerContext,
  type NewTaskComposerHandoff,
} from "./new-task-composer";

type HeroSuggestion = {
  title: string;
  description: string;
  prompt: string;
};

/** The coding task templates (task-suggestions.tsx): filled in, never sent on their own. */
const DEFAULT_SUGGESTIONS: HeroSuggestion[] = CODING_STARTER_CARDS.map((card) => ({
  title: card.title,
  description: card.description,
  prompt: card.prompt,
}));

type TimeGreeting = {
  title: string;
  subtitle: string;
};

export function greetingForLocalHour(hour: number): TimeGreeting {
  if (hour < 5) {
    return {
      title: "what would you like to work on?",
      subtitle: "describe the outcome you need",
    };
  }

  if (hour < 12) {
    return {
      title: "good morning. how can I help?",
      subtitle: "what are we getting done?",
    };
  }

  if (hour < 17) {
    return {
      title: "good afternoon. how can I help?",
      subtitle: "what should we tackle?",
    };
  }

  if (hour < 22) {
    return {
      title: "good evening. how can I help?",
      subtitle: "what are we getting done?",
    };
  }

  return {
    title: "what would you like to work on?",
    subtitle: "describe the outcome you need",
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
};

/**
 * Paper "first chat" empty state: the real session composer front and
 * center with suggestion cards below. Suggestions come from desktop
 * policies (organization onboarding prompts) when configured, with
 * built-in defaults otherwise.
 */
export function SessionEmptyHero(props: SessionEmptyHeroProps) {
  const [prompt, setPrompt] = useState("");
  const [greeting] = useState(() => greetingForLocalHour(new Date().getHours()));
  const orgRestrictions = useOrgRestrictions();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const canAddProviders = !checkDesktopRestriction({ restriction: "allowCustomProviders" });
  const organizationPrompts = orgRestrictions.onboardingPrompts;
  const suggestions: HeroSuggestion[] = organizationPrompts !== undefined
    ? organizationPrompts.map((orgPrompt, index) => {
      const card = resolveOrganizationPromptCardContent({
        prompt: orgPrompt,
        description: orgRestrictions.onboardingPromptDescriptions?.[index],
        index,
      });
      return { title: card.title, description: card.description, prompt: card.selectionPrompt };
    })
    : DEFAULT_SUGGESTIONS;

  const submit = (
    resolvedPrompt: string,
    attachments: ComposerAttachment[],
    handoff?: NewTaskComposerHandoff,
  ) => {
    const trimmedPrompt = resolvedPrompt.trim();
    if ((!trimmedPrompt && !attachments.length) || props.busy) return;
    return props.onRunTask(trimmedPrompt, attachments, handoff);
  };

  const fillPrompt = (value: string) => {
    setPrompt(value);
    window.dispatchEvent(new Event("omnirush:focusPrompt"));
  };

  return (
    <div className="mx-auto w-full max-w-[640px] space-y-4 px-4 max-lg:px-4 sm:px-6">
      <div className="space-y-1.5 text-center">
        <h2 className="text-[24px] font-semibold leading-[30px] tracking-[-0.02em] text-foreground">
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
            <div className="text-[13px] font-medium text-foreground">connect a model provider</div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              add an api key for openai, anthropic, google, or openrouter so tasks can run.
            </div>
          </div>
        </button>
      ) : null}

      <div className="grid grid-cols-2 gap-1.5">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.title}
            type="button"
            title={suggestion.description}
            aria-label={`${suggestion.title}: ${suggestion.description}`}
            className="group flex min-h-10 items-center justify-between gap-2 rounded-lg border border-border/80 bg-background px-3 py-2 text-left transition-colors hover:bg-accent"
            onClick={() => fillPrompt(suggestion.prompt)}
          >
            <span className="truncate text-[12px] font-medium text-foreground">{suggestion.title}</span>
            <span aria-hidden="true" className="shrink-0 text-[12px] text-muted-foreground transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
