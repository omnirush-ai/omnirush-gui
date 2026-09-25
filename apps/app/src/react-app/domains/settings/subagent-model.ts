// Shared sub-agent model and effort state. Settings > Preferences > Model and
// the composer's "Sub-agents" menu both read it through useSubagentModel (one
// react-query cache entry per server), so a change in either shows in the
// other at once. The setting is server-wide: the engine's swarm plugin applies
// it to every sub-agent (any nesting layer) of new tasks, so no engine reload
// is needed; the main agent keeps its own model and effort.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  OmniRushServerClient,
  OmniRushSubagentModelSetting,
  OmniRushSubagentModelState,
} from "@/app/lib/omnirush-server";
import { OMNIRUSH_REASONING_EFFORTS } from "@/app/constants";
import { formatGenericBehaviorLabel } from "@/app/lib/model-behavior";

export type SubagentModelClient = Pick<OmniRushServerClient, "getSubagentModel" | "setSubagentModel"> & {
  /** Keys the shared state; clients without one share a single entry. */
  baseUrl?: string;
};

export const SAME_AS_MAIN_LABEL = "Same as main agent";
export const SUBAGENT_MODEL_HELP =
  "Sub-agents are the helpers the main agent starts with the task tool, at every nesting layer. The main agent keeps its own model and effort. If the picked model is not available to your account or omnirush.ai refuses it, sub-agents run on the main agent's model and the session says so.";
export const SUBAGENT_EFFORT_HELP =
  "How hard sub-agents think. \"Same as main agent\" uses the main agent's effort, mapped to the nearest level the sub-agent model offers.";

export const DEFAULT_SUBAGENT_SETTING: OmniRushSubagentModelSetting = { model: null, effort: null };

export function subagentModelQueryKey(client: SubagentModelClient | null): readonly unknown[] {
  return ["omnirush-subagent-model", client?.baseUrl?.trim() || "default"];
}

/** Efforts offered for `model` (lowest first); "same as main" offers every level any catalog model has. */
export function subagentEffortOptions(state: OmniRushSubagentModelState | undefined, model: string | null): string[] {
  const models = state?.models ?? [];
  const offered = model
    ? models.find((entry) => entry.id === model)?.efforts ?? []
    : models.flatMap((entry) => entry.efforts);
  return OMNIRUSH_REASONING_EFFORTS.filter((effort) => offered.includes(effort));
}

/**
 * The setting after picking `next`: an effort the newly picked model does not
 * offer goes back to "same as main" rather than silently changing level.
 */
export function nextSubagentSetting(
  state: OmniRushSubagentModelState | undefined,
  current: OmniRushSubagentModelSetting,
  next: Partial<OmniRushSubagentModelSetting>,
): OmniRushSubagentModelSetting {
  const model = next.model !== undefined ? next.model : current.model;
  const effort = next.effort !== undefined ? next.effort : current.effort;
  return { model, effort: effort && subagentEffortOptions(state, model).includes(effort) ? effort : null };
}

export function subagentModelName(state: OmniRushSubagentModelState | undefined, model: string | null): string {
  if (!model) return SAME_AS_MAIN_LABEL;
  return state?.models.find((entry) => entry.id === model)?.name ?? model;
}

export function subagentEffortLabel(effort: string | null): string {
  return effort ? formatGenericBehaviorLabel(effort) : SAME_AS_MAIN_LABEL;
}

/** "Same as main agent", "GPT 6 Sol", "GPT 6 Sol · High" or "Main model · Low". */
export function subagentSummary(state: OmniRushSubagentModelState | undefined, setting: OmniRushSubagentModelSetting): string {
  if (!setting.model && !setting.effort) return SAME_AS_MAIN_LABEL;
  const model = setting.model ? subagentModelName(state, setting.model) : "Main model";
  return setting.effort ? `${model} · ${formatGenericBehaviorLabel(setting.effort)}` : model;
}

/** Whether the picked model is missing from the account's catalog (sub-agents then run on the main model). */
export function subagentModelUnavailable(state: OmniRushSubagentModelState | undefined, setting: OmniRushSubagentModelSetting): boolean {
  if (!setting.model || !state) return false;
  return !state.signedIn || !state.models.some((entry) => entry.id === setting.model);
}

/** The server's setting and catalog, loaded once per server, and the action that saves a change. */
export function useSubagentModel(client: SubagentModelClient | null) {
  const queryClient = useQueryClient();
  const queryKey = subagentModelQueryKey(client);
  const query = useQuery({
    queryKey,
    queryFn: () => client!.getSubagentModel(),
    enabled: Boolean(client),
    retry: false,
    staleTime: 30_000,
  });
  const mutation = useMutation({
    mutationKey: queryKey,
    mutationFn: (setting: OmniRushSubagentModelSetting) => client!.setSubagentModel(setting),
    onSuccess: (result) => {
      queryClient.setQueryData<OmniRushSubagentModelState | undefined>(queryKey, (previous) =>
        previous ? { ...previous, setting: result.setting } : previous);
    },
  });
  const state = query.data;
  const setting = state?.setting ?? DEFAULT_SUBAGENT_SETTING;
  return {
    state,
    setting,
    loading: query.isPending && Boolean(client),
    error: query.error instanceof Error ? query.error.message : mutation.error instanceof Error ? mutation.error.message : null,
    saving: mutation.isPending,
    refetch: () => query.refetch(),
    /** Saves `next` merged into the current setting; resolves to the saved setting. */
    change: (next: Partial<OmniRushSubagentModelSetting>) =>
      mutation.mutateAsync(nextSubagentSetting(state, setting, next)).then((result) => result.setting),
  };
}
