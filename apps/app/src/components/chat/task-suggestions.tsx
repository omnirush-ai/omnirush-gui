"use client"

import {
  DescriptiveButton,
  DescriptiveButtonContent,
  DescriptiveButtonDescription,
  DescriptiveButtonIcon,
  DescriptiveButtonTitle,
} from "@/components/descriptive-button"
import { useMessageList } from "@/components/chat/message-list-provider"
import { cn } from "@/lib/utils"
import { useOrgRestrictions } from "@/react-app/domains/cloud/desktop-config-provider"
import {
  ArrowPathIcon,
  BoltIcon,
  BugAntIcon,
  CpuChipIcon,
  RocketLaunchIcon,
  ServerStackIcon,
  SparklesIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/solid"

/**
 * Real coding work in the user's own project, one card per kind of work the
 * quality check values. Clicking puts the template in the composer to fill
 * in; it is never sent on its own.
 */
export const CODING_STARTER_CARDS = [
  {
    id: "hard-bug",
    title: "Fix a hard bug",
    description: "Reproduce it, find the root cause, fix and test",
    prompt: "There's a bug in this project: {describe the symptom}. Reproduce it with a failing test or command first, find the root cause, fix it, and run the tests until they pass.",
    Icon: BugAntIcon,
    iconClass: "text-red-10",
  },
  {
    id: "faster",
    title: "Make it faster",
    description: "Measure, find the bottleneck, show before/after",
    prompt: "{Part} of this project is too slow. Measure it first (benchmark or profiler), find the bottleneck, optimise it, and show before/after numbers.",
    Icon: BoltIcon,
    iconClass: "text-amber-10",
  },
  {
    id: "build",
    title: "Fix the build",
    description: "Get the build, CI or Docker setup passing",
    prompt: "The build/CI/Docker setup for this project is broken or missing: {what}. Get it building from a clean checkout and make the build pass.",
    Icon: WrenchScrewdriverIcon,
    iconClass: "text-blue-10",
  },
  {
    id: "refactor",
    title: "Refactor or migrate",
    description: "Move a module or library, keep behaviour the same",
    prompt: "Migrate {module/library} in this project to {target}. Update every caller, keep behaviour the same, and run the tests after each step.",
    Icon: ArrowPathIcon,
    iconClass: "text-purple-10",
  },
  {
    id: "feature",
    title: "Build a real feature",
    description: "Design, implement across the code, add tests",
    prompt: "Add {feature} to this project end to end: design it, implement it across the code that needs it, add tests, and run them.",
    Icon: RocketLaunchIcon,
    iconClass: "text-green-10",
  },
  {
    id: "systems",
    title: "Systems work",
    description: "Networking, storage, scheduling or concurrency",
    prompt: "Work on {the networking/storage/scheduler/concurrency part} of this project: {goal}. Write tests that exercise it and run them.",
    Icon: ServerStackIcon,
    iconClass: "text-cyan-10",
  },
] as const

const ORGANIZATION_PROMPT_TITLES = ["Organization prompt 1", "Organization prompt 2", "Organization prompt 3"]

export function resolveOrganizationPromptCardContent(input: {
  prompt: string
  description?: string
  index: number
}) {
  const title = input.description?.trim()
  return {
    title: title || ORGANIZATION_PROMPT_TITLES[input.index] || "Organization prompt",
    description: input.prompt,
    selectionPrompt: input.prompt,
  }
}

interface TaskSuggestionsProps {
  className?: string
}

export function TaskSuggestions({ className }: TaskSuggestionsProps) {
  const { displaySuggestions, providerConnectedCount, dispatchAction, setPrompt } = useMessageList()
  const orgRestrictions = useOrgRestrictions()
  const organizationPrompts = orgRestrictions.onboardingPrompts
  const organizationPromptDescriptions = orgRestrictions.onboardingPromptDescriptions

  if (!displaySuggestions) {
    return null
  }

  const noProviders = providerConnectedCount === 0
  const hasOrganizationPrompts = organizationPrompts !== undefined

  return (
    <div className={cn("@container flex flex-col gap-4 pt-1", className)}>
      <p className="text-muted-foreground font-medium select-none">
        {noProviders
          ? "Connect a model provider to get started:"
          : hasOrganizationPrompts
            ? "Try one of your organization's prompts:"
            : "Try one of these:"}
      </p>
      <div className="grid min-w-0 gap-2 @lg:grid-cols-2 @2xl:grid-cols-3">
        {noProviders ? (
          <DescriptiveButton
            orientation="vertical"
            className="border-blue-7/50 bg-blue-2/30 hover:bg-blue-3/40 @lg:col-span-2 @2xl:col-span-3"
            onClick={() =>
              dispatchAction({
                target: "settings",
                action: "open",
                section: "providers",
              })
            }
          >
            <DescriptiveButtonIcon>
              <BoltIcon className="size-6 text-blue-10" aria-hidden />
            </DescriptiveButtonIcon>
            <DescriptiveButtonContent>
              <DescriptiveButtonTitle>Connect a model provider</DescriptiveButtonTitle>
              <DescriptiveButtonDescription>
                Add an API key for Anthropic, OpenAI, Google, or others
              </DescriptiveButtonDescription>
            </DescriptiveButtonContent>
          </DescriptiveButton>
        ) : null}

        {hasOrganizationPrompts ? (
          organizationPrompts.map((prompt, index) => {
            const card = resolveOrganizationPromptCardContent({
              prompt,
              description: organizationPromptDescriptions?.[index],
              index,
            })
            return (
              <DescriptiveButton key={`${index}-${prompt}`} orientation="vertical" onClick={() => setPrompt(card.selectionPrompt)}>
                <DescriptiveButtonIcon>
                  <SparklesIcon className="size-6 text-purple-10" aria-hidden />
                </DescriptiveButtonIcon>
                <DescriptiveButtonContent>
                  <DescriptiveButtonTitle>{card.title}</DescriptiveButtonTitle>
                  <DescriptiveButtonDescription>{card.description}</DescriptiveButtonDescription>
                </DescriptiveButtonContent>
              </DescriptiveButton>
            )
          })
        ) : (
          CODING_STARTER_CARDS.map((card) => (
            <DescriptiveButton
              key={card.id}
              orientation="vertical"
              data-testid={`starter-card-${card.id}`}
              onClick={() => setPrompt(card.prompt)}
            >
              <DescriptiveButtonIcon>
                <card.Icon className={cn("size-6", card.iconClass)} aria-hidden />
              </DescriptiveButtonIcon>
              <DescriptiveButtonContent>
                <DescriptiveButtonTitle>{card.title}</DescriptiveButtonTitle>
                <DescriptiveButtonDescription>{card.description}</DescriptiveButtonDescription>
              </DescriptiveButtonContent>
            </DescriptiveButton>
          ))
        )}
      </div>
    </div>
  )
}
