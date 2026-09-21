/** @jsxImportSource react */
import { useState } from "react";
import { Zap } from "lucide-react";

import type { ComposerAttachment } from "@/app/types";
import { resolveOrganizationPromptCardContent } from "@/components/chat/task-suggestions";
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

const DEFAULT_SUGGESTIONS: HeroSuggestion[] = [
  {
    title: "Summarize my week",
    description: "Pull highlights from email and calendar.",
    prompt: "Summarize my week: pull the highlights from my connected email and calendar and give me a short digest of what happened and what needs my attention.",
  },
  {
    title: "Clean up a spreadsheet",
    description: "Drop in a CSV and describe the result you want.",
    prompt: "Create a sample CSV file with 20 rows of fake customer data (name, email, company, revenue). Then show me a summary of the data.",
  },
  {
    title: "Draft a document",
    description: "Reports, emails, or briefs from a few bullet points.",
    prompt: "Draft a one-page project brief. Ask me for the bullet points you need, then turn them into a clear, well-structured document.",
  },
  {
    title: "Automate a web task",
    description: "Use the built-in browser for repetitive steps.",
    prompt: "Open craigslist.org in the browser and search for couches for sale. Show me the top 5 results with prices.",
  },
];

type TimeGreeting = {
  title: string;
  subtitle: string;
};

export function greetingForLocalHour(hour: number): TimeGreeting {
  if (hour < 5) {
    return {
      title: "still up? let's make it count 🌙",
      subtitle: "tell me what we're building",
    };
  }

  if (hour < 12) {
    return {
      title: "good morning, let's make something cool ☀️",
      subtitle: "what are we getting done?",
    };
  }

  if (hour < 17) {
    return {
      title: "good afternoon, let's cook ✨",
      subtitle: "what should we tackle?",
    };
  }

  if (hour < 22) {
    return {
      title: "good evening, ready to make some magic? 🌙",
      subtitle: "what are we getting done?",
    };
  }

  return {
    title: "late-night mode, let's ship something 🌙",
    subtitle: "what are we building?",
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
