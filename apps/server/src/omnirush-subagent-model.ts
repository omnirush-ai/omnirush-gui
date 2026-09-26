/**
 * The sub-agent model and effort picker: which omnirush.ai model and effort
 * the task tool's sub-agents (every nesting layer) run on, and the fallback
 * to the main agent's model when that model cannot serve them.
 *
 * The setting is kept at <runtimeStorageDir>/omnirush-subagent-model.json.
 * Untouched (both fields null, or no file) nothing changes: sub-agents keep
 * the engine's own inheritance of the main agent's model and effort, exactly
 * as before the picker existed.
 *
 * Who does what:
 *   - The app reads and writes the setting (GET/PUT /omnirush/subagent-model).
 *   - The swarm engine plugin asks POST /omnirush/subagent-model/resolve for
 *     every prompt of a sub-agent session and puts the answer on the user
 *     message before it is saved, so the engine runs (and records) that model
 *     and effort for the sub-agent, and so do the collector's traces.
 *   - A picked model that is not in the account's catalog, or that the
 *     gateway refused recently, resolves to the main model instead (a
 *     "selection" fallback, noted on the sub-agent session).
 *   - A request the gateway refuses while a sub-agent runs on the picked
 *     model is sent again on the main model by the gateway broker (a
 *     "gateway" fallback), which marks the model refused for a while; the
 *     collector then records the main model on those sub-agent messages.
 *
 * Kept free of engine-plugin imports; the plugin talks to it over HTTP.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic-write.js";
import {
  OMNIRUSH_MODEL_EFFORTS,
  type OmniRushModelCatalog,
  type OmniRushModelEffort,
} from "./omnirush-model-catalog.js";
import { runtimeStorageDir } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

export const OMNIRUSH_PROVIDER_ID = "omnirush";

export {
  SUBAGENT_FALLBACK_EFFORT_HEADER,
  SUBAGENT_FALLBACK_MODEL_HEADER,
  SUBAGENT_MODEL_FALLBACK_TRACE,
  SUBAGENT_ROOT_SESSION_HEADER,
} from "./omnirush-swarm.js";


/** How long a model the gateway refused for a sub-agent is skipped for new sub-agent prompts. */
export const SUBAGENT_MODEL_REFUSAL_COOLDOWN_MS = 5 * 60_000;

export type SubagentModelSetting = {
  /** An omnirush.ai catalog model id; null = the main agent's model. */
  model: string | null;
  /** An effort; null = the main agent's effort (the nearest one the model offers). */
  effort: OmniRushModelEffort | null;
};

export const DEFAULT_SUBAGENT_MODEL_SETTING: SubagentModelSetting = Object.freeze({ model: null, effort: null });

export type EngineModelRef = { providerID: string; modelID: string };

export type SubagentFallbackReason = "not_in_catalog" | "signed_out" | "refused";

export type SubagentModelResolution = {
  /** The model and effort to put on the sub-agent's prompt; absent = leave the prompt as the engine made it. */
  model?: EngineModelRef;
  /** The effort (engine variant) to use; null = the model's default. Only meaningful with `model`. */
  variant?: string | null;
  /** Set when the picked model could not be used and the main model was chosen instead. */
  fallback?: {
    requested: string;
    requestedName: string;
    used: string;
    usedName: string;
    reason: SubagentFallbackReason;
  };
  /**
   * The main model (and the effort for it) the gateway broker switches to if
   * the gateway refuses the picked model mid-task. Absent when the main model
   * is not an omnirush.ai model or is the picked model itself.
   */
  gatewayFallback?: { model: string; effort: string | null };
};

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EFFORT_RANK: Record<string, number> = Object.fromEntries(OMNIRUSH_MODEL_EFFORTS.map((effort, index) => [effort, index]));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSubagentEffort(value: unknown): OmniRushModelEffort | null {
  if (typeof value !== "string") return null;
  const effort = value.trim().toLowerCase();
  // `ultra` is the legacy spelling of `max`.
  const normalized = effort === "ultra" ? "max" : effort;
  return (OMNIRUSH_MODEL_EFFORTS as readonly string[]).includes(normalized) ? normalized as OmniRushModelEffort : null;
}

/** A stored or submitted setting; anything unusable reads as "same as main". */
export function sanitizeSubagentModelSetting(raw: unknown): SubagentModelSetting {
  if (!isRecord(raw)) return { ...DEFAULT_SUBAGENT_MODEL_SETTING };
  const model = typeof raw.model === "string" && MODEL_ID.test(raw.model.trim()) ? raw.model.trim() : null;
  return { model, effort: parseSubagentEffort(raw.effort) };
}

export function subagentModelSettingPath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "omnirush-subagent-model.json");
}

export async function readSubagentModelSetting(config: ServerConfig): Promise<SubagentModelSetting> {
  const raw = await readFile(subagentModelSettingPath(config), "utf8").catch(() => null);
  if (raw === null) return { ...DEFAULT_SUBAGENT_MODEL_SETTING };
  try {
    return sanitizeSubagentModelSetting(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SUBAGENT_MODEL_SETTING };
  }
}

/**
 * Atomic (temp file, fsync, rename), so a resolve never reads a partial file.
 * The rename is retried while Windows reports the file busy; a save that
 * still fails throws an AtomicWriteError (the errno code on `.code`) and
 * leaves the previous setting in place.
 */
export async function writeSubagentModelSetting(config: ServerConfig, setting: SubagentModelSetting): Promise<SubagentModelSetting> {
  const clean = sanitizeSubagentModelSetting(setting);
  const path = subagentModelSettingPath(config);
  await mkdir(runtimeStorageDir(config), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(clean, null, 2)}\n`);
  return clean;
}

/**
 * The effort a model offers that is closest to `effort` (ties go to the
 * higher one), or null when the model offers none. An unknown effort is null.
 */
export function nearestEffort(effort: string | null | undefined, levels: readonly string[]): string | null {
  const wanted = parseSubagentEffort(effort);
  if (!wanted || levels.length === 0) return null;
  if (levels.includes(wanted)) return wanted;
  const rank = EFFORT_RANK[wanted]!;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of levels) {
    const levelRank = EFFORT_RANK[level];
    if (levelRank === undefined) continue;
    const distance = Math.abs(levelRank - rank);
    if (distance < bestDistance || (distance === bestDistance && levelRank > EFFORT_RANK[best!]!)) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

/** Models the gateway refused for sub-agents, per server: model id -> until (epoch ms) and why. */
export class SubagentModelRefusals {
  private readonly refused = new Map<string, { until: number; reason: string }>();

  constructor(private readonly now: () => number = Date.now, private readonly cooldownMs = SUBAGENT_MODEL_REFUSAL_COOLDOWN_MS) {}

  mark(model: string, reason: string): void {
    this.refused.set(model, { until: this.now() + this.cooldownMs, reason });
    if (this.refused.size > 64) this.refused.delete(this.refused.keys().next().value as string);
  }

  isRefused(model: string): boolean {
    const entry = this.refused.get(model);
    if (!entry) return false;
    if (entry.until > this.now()) return true;
    this.refused.delete(model);
    return false;
  }

  clear(): void {
    this.refused.clear();
  }
}

const refusalsByServer = new WeakMap<ServerConfig, SubagentModelRefusals>();

export function subagentModelRefusals(config: ServerConfig): SubagentModelRefusals {
  let refusals = refusalsByServer.get(config);
  if (!refusals) {
    refusals = new SubagentModelRefusals();
    refusalsByServer.set(config, refusals);
  }
  return refusals;
}

function displayName(catalog: OmniRushModelCatalog, id: string): string {
  return catalog.find((model) => model.id === id)?.display_name ?? id;
}

function levelsOf(catalog: OmniRushModelCatalog, ref: EngineModelRef): string[] | null {
  if (ref.providerID !== OMNIRUSH_PROVIDER_ID) return null;
  return catalog.find((model) => model.id === ref.modelID)?.reasoning_levels ?? null;
}

/** The effort for `ref`: the picked effort, else `inherited`, mapped to what the model offers. */
function effortFor(
  catalog: OmniRushModelCatalog,
  ref: EngineModelRef,
  picked: OmniRushModelEffort | null,
  inherited: string | null | undefined,
): string | null {
  const levels = levelsOf(catalog, ref);
  const wanted = picked ?? inherited ?? null;
  if (!wanted) return null;
  // Another provider's variants are unknown here: an inherited effort passes as is.
  if (levels === null) return picked ? null : wanted;
  return nearestEffort(wanted, levels);
}

function sameModel(left: EngineModelRef, right: EngineModelRef): boolean {
  return left.providerID === right.providerID && left.modelID === right.modelID;
}

/**
 * What a sub-agent prompt runs on.
 *
 * `inherited` is what the engine put on the prompt (the delegating agent's
 * model and effort); `main` is the main session's own model and effort when
 * the plugin knows it (else `inherited` stands in, unless it is the picked
 * model, in which case the catalog default does).
 */
export function resolveSubagentModel(input: {
  setting: SubagentModelSetting;
  catalog: OmniRushModelCatalog;
  /** Whether the engine has the omnirush.ai provider (signed in). */
  gateway: boolean;
  inherited: EngineModelRef & { variant?: string | null };
  main?: (EngineModelRef & { variant?: string | null }) | null;
  refused?: (model: string) => boolean;
}): SubagentModelResolution {
  const { setting, catalog, inherited } = input;
  if (!setting.model && !setting.effort) return {};
  const defaultModel = catalog.find((model) => model.default) ?? catalog[0];
  const main: EngineModelRef & { variant?: string | null } = input.main
    ?? (setting.model && inherited.providerID === OMNIRUSH_PROVIDER_ID && inherited.modelID === setting.model && defaultModel
      ? { providerID: OMNIRUSH_PROVIDER_ID, modelID: defaultModel.id, variant: null }
      : inherited);

  if (!setting.model) {
    // Same model as the delegating agent; only the effort is picked.
    const variant = effortFor(catalog, inherited, setting.effort, inherited.variant);
    return levelsOf(catalog, inherited) === null
      ? {}
      : { model: { providerID: inherited.providerID, modelID: inherited.modelID }, variant };
  }

  const picked: EngineModelRef = { providerID: OMNIRUSH_PROVIDER_ID, modelID: setting.model };
  const reason: SubagentFallbackReason | null = !input.gateway
    ? "signed_out"
    : !catalog.some((model) => model.id === setting.model)
      ? "not_in_catalog"
      : input.refused?.(setting.model)
        ? "refused"
        : null;

  if (reason) {
    const mainRef = { providerID: main.providerID, modelID: main.modelID };
    return {
      model: mainRef,
      variant: effortFor(catalog, mainRef, setting.effort, main.variant),
      fallback: {
        requested: setting.model,
        requestedName: displayName(catalog, setting.model),
        used: main.modelID,
        usedName: displayName(catalog, main.modelID),
        reason,
      },
    };
  }

  const resolution: SubagentModelResolution = {
    model: picked,
    variant: effortFor(catalog, picked, setting.effort, main.variant ?? inherited.variant),
  };
  if (main.providerID === OMNIRUSH_PROVIDER_ID && !sameModel(main, picked) && catalog.some((model) => model.id === main.modelID)) {
    resolution.gatewayFallback = {
      model: main.modelID,
      effort: effortFor(catalog, main, setting.effort, main.variant),
    };
  }
  return resolution;
}

/** A readable note for a sub-agent session that runs on the main model instead of the picked one. */
export function subagentFallbackNote(fallback: NonNullable<SubagentModelResolution["fallback"]> | { requestedName: string; usedName: string; reason: string }): string {
  const why = fallback.reason === "not_in_catalog"
    ? "is not available to this account"
    : fallback.reason === "signed_out"
      ? "needs an omnirush.ai account"
      : "was refused by omnirush.ai";
  return `ran on ${fallback.usedName}: ${fallback.requestedName} ${why}`;
}
