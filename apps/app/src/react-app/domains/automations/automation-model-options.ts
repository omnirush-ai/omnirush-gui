import type { DenOrgLlmProvider } from "@/app/lib/den"
import { formatGenericBehaviorLabel, getModelBehaviorSummary } from "@/app/lib/model-behavior"
import type { ModelOption, ProviderListItem } from "@/app/types"
import { resolveModelDisplayName, resolveModelProviderDisplayName } from "@/app/utils"
import type { AutomationModel } from "@omnirush/types/automations"
import { INFERENCE_MODEL_ALIASES } from "@omnirush/types/den/inference"

/** providerId → modelId → the local runtime's model record. */
export type AutomationProviderCatalog = Record<string, Record<string, ProviderListItem["models"][string]>>

export type AutomationModelOption = {
  providerId: string
  modelId: string
  providerName: string
  modelName: string
  accessKind: "omnirush_managed" | "authorized_custom"
}

export type ResolvedProposalModel = {
  model: AutomationModel
  resolution: "exact" | "mapped" | "default" | "fallback"
}

export const AUTOMATION_INTERNAL_MODEL = {
  providerId: "omnirush",
  modelId: "z-ai/glm-5.2",
  providerName: "omnirush.ai Models",
  modelName: "GLM-5.2",
} satisfies Omit<AutomationModelOption, "accessKind">

const internalStarterModel: AutomationModelOption = {
  ...AUTOMATION_INTERNAL_MODEL,
  accessKind: "omnirush_managed",
}

function omniRushManagedModels(provider: DenOrgLlmProvider): AutomationModelOption[] {
  return Object.entries(INFERENCE_MODEL_ALIASES)
    .filter(([, model]) => model.enabled)
    .map(([modelId, model]) => ({
      providerId: "omnirush",
      modelId,
      providerName: provider.name,
      modelName: model.displayName.replace(/^omnirush.ai:\s*/, ""),
      accessKind: "omnirush_managed" as const,
    }))
}

function authorizedProviderModels(provider: DenOrgLlmProvider): AutomationModelOption[] {
  return provider.models.map((model) => ({
    providerId: provider.id,
    modelId: model.id,
    providerName: resolveModelProviderDisplayName(provider.id, model.id, provider.name, model.name),
    modelName: resolveModelDisplayName(model.id, model.name),
    accessKind: "authorized_custom" as const,
  }))
}

/**
 * Den's usable-provider response is already scoped to the active member. Keep
 * the submitted value normalized to the same IDs the server revalidates:
 * `omnirush` or the concrete `lpr_*` provider record.
 */
export function automationModelOptions(
  providers: readonly DenOrgLlmProvider[],
  options: { includeInternalStarter?: boolean } = {},
): AutomationModelOption[] {
  const managed = providers.flatMap((provider) => provider.source === "omnirush"
    ? omniRushManagedModels(provider)
    : authorizedProviderModels(provider))

  return [
    ...(options.includeInternalStarter === false ? [] : [internalStarterModel]),
    ...managed.filter((model) =>
      model.providerId !== internalStarterModel.providerId
      || model.modelId !== internalStarterModel.modelId),
  ].sort((left, right) => {
    const kindOrder = ["omnirush_managed", "authorized_custom"]
    return kindOrder.indexOf(left.accessKind) - kindOrder.indexOf(right.accessKind)
      || left.providerName.localeCompare(right.providerName)
      || left.modelName.localeCompare(right.modelName)
  })
}

export function automationProviderCatalog(
  providers: readonly ProviderListItem[] | undefined,
): AutomationProviderCatalog {
  const catalog: AutomationProviderCatalog = {}
  for (const provider of providers ?? []) catalog[provider.id] = { ...(provider.models ?? {}) }
  return catalog
}

export function findAutomationModelOption(
  options: readonly AutomationModelOption[],
  model: Pick<AutomationModel, "providerId" | "modelId">,
) {
  return options.find((option) =>
    option.providerId === model.providerId && option.modelId === model.modelId) ?? null
}

export function resolveProposalModel(
  proposed: AutomationModel | undefined,
  providers: readonly DenOrgLlmProvider[],
): ResolvedProposalModel {
  const internalModel: AutomationModel = {
    providerId: AUTOMATION_INTERNAL_MODEL.providerId,
    modelId: AUTOMATION_INTERNAL_MODEL.modelId,
    variant: null,
  }
  if (!proposed) return { model: internalModel, resolution: "default" }

  if (findAutomationModelOption(automationModelOptions(providers), proposed)) {
    return { model: proposed, resolution: "exact" }
  }

  const provider = providers.find((candidate) =>
    candidate.source !== "omnirush"
    && candidate.providerId === proposed.providerId
    && candidate.models.some((model) => model.id === proposed.modelId))
  if (provider) {
    return {
      model: {
        providerId: provider.id,
        modelId: proposed.modelId,
        variant: proposed.variant ?? null,
      },
      resolution: "mapped",
    }
  }

  return { model: internalModel, resolution: "fallback" }
}

/**
 * Human label for a stored Automation model. Falls back to the raw identity
 * only when the model is no longer among the ones this member can use, so a
 * revoked model stays inspectable instead of rendering as a blank.
 */
export function describeAutomationModel(
  model: AutomationModel,
  options: readonly AutomationModelOption[],
) {
  const option = findAutomationModelOption(options, model)
  const displayModelName = model.modelId.toLowerCase().includes("gpt")
    ? resolveModelDisplayName(model.modelId, option?.modelName)
    : option?.modelName ?? model.modelId
  const name = option ? `${option.providerName} · ${displayModelName}` : `${model.providerId}/${displayModelName}`
  return model.variant
    ? `${name} · ${model.modelId.toLowerCase().includes("gpt") ? formatGenericBehaviorLabel(model.variant) : model.variant}`
    : name
}

/**
 * Presents the member's authorized Automation models in the shape the shared
 * model picker renders, so an Automation is configured with the same control
 * and the same reasoning levels as a chat.
 *
 * Reasoning variants are a property of the desktop runtime that will execute
 * the run, so they come from the local provider catalog. A model Den authorizes
 * but the local runtime does not know still lists — without variants.
 */
export function automationPickerOptions(input: {
  options: readonly AutomationModelOption[]
  catalog: AutomationProviderCatalog
  selected: AutomationModel
}): ModelOption[] {
  return input.options.map((option) => {
    const isSelected = option.providerId === input.selected.providerId
      && option.modelId === input.selected.modelId
    const model = input.catalog[option.providerId]?.[option.modelId]
    const summary = model
      ? getModelBehaviorSummary(
        option.providerId,
        model,
        isSelected ? input.selected.variant ?? null : null,
        option.providerName,
      )
      : null
    return {
      providerID: option.providerId,
      modelID: option.modelId,
      title: resolveModelDisplayName(option.modelId, option.modelName),
      description: option.providerName,
      behaviorTitle: summary?.title ?? "Reasoning",
      behaviorLabel: summary?.label ?? "Default",
      behaviorDescription: summary?.description ?? "",
      behaviorValue: summary?.value ?? null,
      behaviorOptions: summary?.options ?? [],
      isFree: false,
    }
  })
}
