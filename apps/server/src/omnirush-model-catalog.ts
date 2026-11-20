/**
 * The omnirush.ai model catalog on the desktop: the models the account may
 * use, as the backend lists them at GET /omnirush/v1/models, reduced to what
 * the engine config needs.
 *
 * The backend is trusted for model ids, names, numbers, enums and booleans
 * only. The engine provider itself (npm package, base URL, env, headers,
 * options) stays hardcoded in omnirush-runtime-config.ts, so a catalog can
 * never point the engine anywhere but the local gateway broker.
 *
 * The last good catalog is kept at <runtimeStorageDir>/omnirush-model-catalog.json.
 * Every list the app shows (model picker, sub-agent models, names) comes from
 * it; nothing filters by model id. Without one (first run, offline, or a
 * backend that fails) the engine gets the built-in fallback: the backend's
 * list at 2026-10-04 (GPT 6 Astra, GPT 6.1 Sol, GPT 6 Sol).
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { runtimeStorageDir } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { writeFileAtomic } from "./atomic-write.js";
import { modelHasWebSearch, type WebSearchSwitch } from "./web-search.js";
import { modelModes, type ModelMode } from "./model-modes/model-modes.mjs";
import { switchGroup } from "./model-modes/strict-sessions.mjs";

/** Every effort a catalog model may list, lowest first. */
export const OMNIRUSH_MODEL_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type OmniRushModelEffort = (typeof OMNIRUSH_MODEL_EFFORTS)[number];
/** The default effort: High, what the desktop picker has always shown for Astra and Sol. */
export const OMNIRUSH_DEFAULT_EFFORT: OmniRushModelEffort = "high";

/**
 * The most context a request carries before the engine compacts the chat:
 * the engine compacts once a step's tokens reach `limit.input` minus its
 * 20k reserve (session/overflow.ts), so 265k compacts at about 245k, where
 * Codex compacts these models (90% of a 272k window). Without it the engine
 * waited until context - 32k (368k of 400k), and long chats past 200k made
 * far more failed edits and repeated failing calls. The window itself
 * (`limit.context`, the meter) stays the catalog's.
 *
 * PARITY: omnirush-cli src/opencode-config.js COMPACT_INPUT_LIMIT.
 */
export const OMNIRUSH_COMPACT_INPUT_LIMIT = 265_000;

/** The engine's own output cap per request (provider/transform.ts OUTPUT_TOKEN_MAX). */
const ENGINE_OUTPUT_TOKEN_MAX = 32_000;

/**
 * A model's `limit.input`: OMNIRUSH_COMPACT_INPUT_LIMIT, but never a later
 * compaction than the engine's own point (context - max output) for a
 * smaller window. The engine compacts at input - min(20k, max output), so
 * input = context - maxOut + min(20k, maxOut) keeps that point exactly.
 *
 * PARITY: omnirush-cli src/opencode-config.js compactInputLimit.
 */
export function omnirushCompactInputLimit(limits: { context: number; output: number }): number {
  const maxOut = Math.min(limits.output, ENGINE_OUTPUT_TOKEN_MAX) || ENGINE_OUTPUT_TOKEN_MAX;
  return Math.max(1, Math.min(OMNIRUSH_COMPACT_INPUT_LIMIT, limits.context - maxOut + Math.min(20_000, maxOut)));
}

const MODEL_STATUSES = ["active", "beta", "deprecated"] as const;
export type OmniRushModelStatus = (typeof MODEL_STATUSES)[number];

export type OmniRushCatalogModel = {
  id: string;
  display_name: string;
  /** The model family the backend names ("OpenAI", "Meta Muse"), if any. */
  family: string | null;
  status: OmniRushModelStatus;
  /** Exactly one model of a catalog is the default. */
  default: boolean;
  /** The efforts the model accepts, lowest first; empty means no effort control. */
  reasoning_levels: OmniRushModelEffort[];
  limits: { context: number; output: number };
  capabilities: {
    reasoning: boolean;
    tool_call: boolean;
    web_search: boolean;
    image_input: boolean;
    file_input: boolean;
  };
  /** Where the model may run (model-modes/); absent means both. Kept only when the backend lists it. */
  modes?: ModelMode[];
  /** The provider a chat may switch within (model-modes/strict-sessions.mjs); absent: none, a new chat. */
  switch_group?: string;
};

/** Models in the backend's order, default first. Never empty. */
export type OmniRushModelCatalog = OmniRushCatalogModel[];

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MODELS = 32;
const CONTEXT_LIMIT_RANGE = { min: 1_000, max: 2_000_000 };
const OUTPUT_LIMIT_RANGE = { min: 1_000, max: 256_000 };
/**
 * The family of the models v1.0.9 shipped. The engine gets no `family` for
 * it, so Astra and Sol keep their v1.0.9 entries byte for byte and pickers
 * list them under the provider's own name; any other family is its own group.
 */
const PROVIDER_FAMILY = "OpenAI";

function catalogModel(
  id: string,
  displayName: string,
  family: string | null,
  isDefault: boolean,
): OmniRushCatalogModel {
  return {
    id,
    display_name: displayName,
    family,
    status: "active",
    default: isDefault,
    reasoning_levels: ["low", "high", "xhigh", "max"],
    limits: { context: 400_000, output: 128_000 },
    capabilities: { reasoning: true, tool_call: true, web_search: true, image_input: true, file_input: true },
  };
}

/**
 * The fallback before the first sync (and when no catalog was ever stored):
 * the backend's list at 2026-10-04, Astra the default, with the Codex-route
 * metadata. Only a fallback: the synced catalog replaces it whole.
 */
export function builtinOmniRushModelCatalog(): OmniRushModelCatalog {
  // One provider (the server's switch_group "openai", its Codex route): a chat switches between them before the
  // first catalog sync too, as it does after (a fresh install used to offer a new chat instead).
  return [
    { ...catalogModel("gpt-6-astra", "GPT 6 Astra", PROVIDER_FAMILY, true), switch_group: "openai" },
    { ...catalogModel("gpt-6.1-sol", "GPT 6.1 Sol", PROVIDER_FAMILY, false), switch_group: "openai" },
    { ...catalogModel("gpt-6-sol", "GPT 6 Sol", PROVIDER_FAMILY, false), switch_group: "openai" },
  ];
}

export function omnirushDefaultModelId(catalog: OmniRushModelCatalog): string {
  return (catalog.find((model) => model.default) ?? catalog[0] ?? builtinOmniRushModelCatalog()[0]!).id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Visible text only (no control or bidi characters), trimmed, at most `limit` characters. */
function label(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}]/gu, "").trim();
  return text && text.length <= limit ? text : null;
}

function tokenLimit(value: unknown, range: { min: number; max: number }): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(range.max, Math.max(range.min, Math.floor(value)));
}

function efforts(value: unknown[]): OmniRushModelEffort[] {
  return OMNIRUSH_MODEL_EFFORTS.filter((effort) => value.includes(effort));
}

function sanitizeModel(raw: unknown): OmniRushCatalogModel | null {
  if (!isRecord(raw)) return null;
  const id = raw.id;
  if (typeof id !== "string" || !MODEL_ID.test(id)) return null;
  // The broker serves the Responses API only; a model on another wire API
  // could never answer through it.
  if (raw.api !== undefined && raw.api !== null && raw.api !== "responses") return null;
  // An older backend lists only id, display_name, default and
  // reasoning_levels: the rest gets the shared defaults (the Codex-route
  // metadata). Any id is taken, dots included; none is special.
  const fallback = builtinOmniRushModelCatalog().find((model) => model.id === id)
    ?? catalogModel(id, id, null, false);
  const limits = isRecord(raw.limits) ? raw.limits : {};
  const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
  const flag = (name: keyof OmniRushCatalogModel["capabilities"]) => {
    const value = capabilities[name];
    return typeof value === "boolean" ? value : fallback.capabilities[name];
  };
  const context = tokenLimit(limits.context, CONTEXT_LIMIT_RANGE) ?? fallback.limits.context;
  const output = tokenLimit(limits.output, OUTPUT_LIMIT_RANGE) ?? fallback.limits.output;
  const status = MODEL_STATUSES.find((entry) => entry === raw.status);
  return {
    id,
    display_name: label(raw.display_name, 64) ?? fallback.display_name,
    family: label(raw.family, 32) ?? fallback.family,
    status: status ?? "active",
    default: raw.default === true,
    reasoning_levels: Array.isArray(raw.reasoning_levels) ? efforts(raw.reasoning_levels) : fallback.reasoning_levels,
    limits: { context, output: Math.min(output, context) },
    capabilities: {
      reasoning: flag("reasoning"),
      tool_call: flag("tool_call"),
      web_search: flag("web_search"),
      image_input: flag("image_input"),
      file_input: flag("file_input"),
    },
    ...(Array.isArray(raw.modes) ? { modes: modelModes(raw) } : {}),
    ...(switchGroup(raw) ? { switch_group: switchGroup(raw)! } : {}),
  };
}

/**
 * The catalog in a GET /omnirush/v1/models body (or the cache file, which
 * has the same shape), or null when it holds no usable model. Unknown keys
 * are dropped; only whitelisted fields of the expected types are read.
 */
export function sanitizeOmniRushModelCatalog(raw: unknown): OmniRushModelCatalog | null {
  if (!isRecord(raw) || !Array.isArray(raw.data)) return null;
  const models: OmniRushCatalogModel[] = [];
  const seen = new Set<string>();
  for (const entry of raw.data) {
    if (models.length === MAX_MODELS) break;
    const model = sanitizeModel(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  if (models.length === 0) return null;
  const flagged = models.findIndex((model) => model.default);
  const defaultIndex = flagged < 0 ? 0 : flagged;
  return models.map((model, index) => ({ ...model, default: index === defaultIndex }));
}

/** Stable text for change detection: sanitized models are built in a fixed key order. */
export function canonicalOmniRushModelCatalog(catalog: OmniRushModelCatalog): string {
  return JSON.stringify(catalog);
}

export function omnirushModelCatalogPath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "omnirush-model-catalog.json");
}

/** The last synced catalog, or the built-in one when none is stored or it is unreadable. */
export async function readOmniRushModelCatalog(config: ServerConfig): Promise<OmniRushModelCatalog> {
  const raw = await readFile(omnirushModelCatalogPath(config), "utf8").catch(() => null);
  if (raw === null) return builtinOmniRushModelCatalog();
  try {
    return sanitizeOmniRushModelCatalog(JSON.parse(raw)) ?? builtinOmniRushModelCatalog();
  } catch {
    return builtinOmniRushModelCatalog();
  }
}

/** Atomic (temp file + rename), so a config build never reads a partial file. */
export async function writeOmniRushModelCatalog(config: ServerConfig, catalog: OmniRushModelCatalog): Promise<void> {
  const path = omnirushModelCatalogPath(config);
  await mkdir(runtimeStorageDir(config), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify({ data: catalog }, null, 2)}\n`);
}

export async function clearOmniRushModelCatalog(config: ServerConfig): Promise<void> {
  await rm(omnirushModelCatalogPath(config), { force: true });
}

/**
 * The effort a catalog model runs at when the chat picked none: high where the
 * model offers it, otherwise the level closest to medium
 * (the higher one on a tie). Null for a model without effort control.
 *
 * PARITY: apps/app/src/app/lib/model-behavior.ts (getModelBehaviorSummary's
 * default for the omnirush provider) picks the same level, so the effort the
 * picker shows is the one the engine sends.
 */
export function omnirushDefaultEffort(levels: readonly OmniRushModelEffort[]): OmniRushModelEffort | null {
  if (levels.includes(OMNIRUSH_DEFAULT_EFFORT)) return OMNIRUSH_DEFAULT_EFFORT;
  const medium = OMNIRUSH_MODEL_EFFORTS.indexOf("medium");
  let best: OmniRushModelEffort | null = null;
  for (const level of levels) {
    if (best === null) { best = level; continue; }
    const distance = Math.abs(OMNIRUSH_MODEL_EFFORTS.indexOf(level) - medium);
    const bestDistance = Math.abs(OMNIRUSH_MODEL_EFFORTS.indexOf(best) - medium);
    if (distance < bestDistance || (distance === bestDistance && OMNIRUSH_MODEL_EFFORTS.indexOf(level) > OMNIRUSH_MODEL_EFFORTS.indexOf(best))) best = level;
  }
  return best;
}

/**
 * The `omnirush` provider's engine models. Each model's efforts become
 * variants carrying `reasoningEffort` (the key the engine's OpenAI adapter
 * reads; the omnirush-reasoning-effort plugin and the broker also put it on
 * the wire); every other effort is declared disabled, because the engine
 * merges its own OpenAI reasoning defaults into a model's variants and drops
 * only entries marked disabled. The model-level `options.reasoningEffort` is
 * the default effort (omnirushDefaultEffort): a message without a variant
 * (a sub-agent on its own model, a send before the app knew the model's
 * efforts) still runs at the effort the picker shows. `deprecated` is never
 * passed on: the engine deletes deprecated models, which would strand the
 * sessions pinned to one.
 */
export function engineModelsFromCatalog(catalog: OmniRushModelCatalog, webSearch: WebSearchSwitch | null = null): Record<string, Record<string, unknown>> {
  return Object.fromEntries(catalog.map((model) => {
    const effort = omnirushDefaultEffort(model.reasoning_levels);
    const options = {
      ...(effort ? { reasoningEffort: effort } : {}),
      // The model's own web search (web-search.ts): the engine declares the
      // provider's web_search tool for it. Off, no `hostedWebSearch` key.
      ...(modelHasWebSearch(model, webSearch) ? { hostedWebSearch: { searchContextSize: webSearch!.searchContextSize } } : {}),
    };
    return [model.id, {
      name: model.display_name,
      reasoning: model.capabilities.reasoning,
      tool_call: model.capabilities.tool_call,
      structured_output: true,
      temperature: true,
      variants: {
        ...Object.fromEntries(model.reasoning_levels.map((level) => [level, { reasoningEffort: level }])),
        ...Object.fromEntries(OMNIRUSH_MODEL_EFFORTS
          .filter((level) => !model.reasoning_levels.includes(level))
          .map((level) => [level, { disabled: true }])),
      },
      limit: { context: model.limits.context, input: omnirushCompactInputLimit(model.limits), output: model.limits.output },
      modalities: {
        input: [
          "text",
          ...(model.capabilities.image_input ? ["image"] : []),
          ...(model.capabilities.file_input ? ["pdf"] : []),
        ],
        output: ["text"],
      },
      ...(model.family && model.family !== PROVIDER_FAMILY ? { family: model.family } : {}),
      ...(model.status === "beta" ? { status: "beta" } : {}),
      ...(Object.keys(options).length > 0 ? { options } : {}),
    }];
  }));
}

/**
 * Whether the broker asks for reasoning summaries on a Responses request for
 * `modelId`: a reasoning model of the catalog on the Codex route (the
 * provider's own family; the engine opts in for GPT-5 ids only). Decided by
 * the catalog, so a model added to it (gpt-6.1-sol) gets the summaries the
 * transcript shows without a desktop release.
 */
export function omnirushModelWantsReasoningSummary(catalog: OmniRushModelCatalog, modelId: unknown): boolean {
  if (typeof modelId !== "string") return false;
  const model = catalog.find((entry) => entry.id === modelId);
  return Boolean(model && model.capabilities.reasoning && (model.family ?? PROVIDER_FAMILY) === PROVIDER_FAMILY);
}
