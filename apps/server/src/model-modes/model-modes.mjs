// Per-model modes: which projects a model may run in.
//
// GET /omnirush/v1/models may give a model `modes`: ["native"] (projects
// without the sandbox) or ["box"] (sandbox projects). No `modes` (or one that
// is not a list) means both, so every older catalog is unchanged. A list
// names exactly the modes it allows: ["native"] is native only, [] none.
//
// Every gateway request from a box project carries `X-OmniRush-Box: 1`; one
// without it counts as native. The gateway refuses a model outside the
// request's mode with 400 `model_not_in_mode`, before anything is reserved.
//
// The same file ships in omnirush-cli (src/model-modes/) and omnirush-gui
// (apps/server/src/model-modes/); PARITY.sha256 lists it in both. No imports,
// so the desktop's bundler and the CLI's plain node both load it as is.

export const MODES = Object.freeze(["native", "box"]);
export const BOX_HEADER = "x-omnirush-box";
export const MODEL_NOT_IN_MODE = "model_not_in_mode";

/** "box" for a sandbox project, else "native". */
export function projectMode(box) {
  return box ? "box" : "native";
}

/** The modes a catalog entry allows: its `modes` known values, or both when it has no list. */
export function modelModes(entry) {
  const raw = entry && typeof entry === "object" ? entry.modes : undefined;
  if (!Array.isArray(raw)) return [...MODES];
  return MODES.filter((mode) => raw.includes(mode));
}

/** Whether a catalog entry may run in `mode`. */
export function modelAllowedIn(entry, mode) {
  return modelModes(entry).includes(mode);
}

/**
 * The model a project in `mode` starts on: `wanted` (a catalog id) when the
 * catalog allows it there, else the catalog's default among the allowed ones,
 * else the first allowed. `note` says what changed when `wanted` was refused.
 * With no allowed model at all, `model` is null (the gateway would refuse
 * every one) and `models` is empty.
 */
export function modelForMode(catalog, mode, wanted = null) {
  const list = Array.isArray(catalog) ? catalog : [];
  const models = list.filter((entry) => modelAllowedIn(entry, mode));
  const asked = wanted ? list.find((entry) => entry.id === wanted) : null;
  if (asked && models.includes(asked)) return { model: asked.id, models, note: null };
  const fallback = models.find((entry) => entry.default === true) ?? models[0] ?? null;
  const note = asked && fallback ? modeSwitchNote(nameOf(asked), nameOf(fallback), mode) : asked ? notInModeMessage(mode) : null;
  return { model: fallback ? fallback.id : null, models, note };
}

function nameOf(entry) {
  const name = entry.display_name ?? entry.name;
  return typeof name === "string" && name.trim() ? name.trim() : entry.id;
}

function where(mode) {
  return mode === "box" ? "in sandbox projects" : "outside the sandbox";
}

/** "Kimi K3.1 Pro isn't available in sandbox projects. Using GPT 6 Astra here." */
export function modeSwitchNote(from, to, mode) {
  return `${from} isn't available ${where(mode)}. Using ${to} here.`;
}

/** The plain message for a `model_not_in_mode` refusal. */
export function notInModeMessage(mode = null) {
  const scope = mode === "box" || mode === "native" ? where(mode) : "in this project";
  return `This model isn't available ${scope}. Pick another model and send again.`;
}

/** The request headers for a project: `{ "x-omnirush-box": "1" }` in a box project, else none. */
export function modeHeaders(box) {
  return box ? { [BOX_HEADER]: "1" } : {};
}

/**
 * How a new chat on `modelId` starts, as the server resolved it
 * (GET /collect/capabilities local_box.model_start, with the policy's
 * `revision`): { start: "native" | "box", switchable, revision }, or null
 * when the server does not say (an older server, a model it does not list):
 * the caller then decides from the model's modes and the level. A chat pins
 * what it started with (its model, where it ran, the revision) and never
 * moves; a different choice is a new chat.
 */
export function serverModelStart(localBox, modelId) {
  const table = localBox && typeof localBox === "object" ? localBox.model_start : null;
  const entry = table && typeof table === "object" && typeof modelId === "string" ? table[modelId] : null;
  if (!entry || typeof entry !== "object" || (entry.start !== "native" && entry.start !== "box")) return null;
  const revision = typeof localBox.revision === "string" && /^lb1:[0-9a-f]{12}$/.test(localBox.revision) ? localBox.revision : null;
  return { start: entry.start, switchable: entry.switchable === true, revision };
}
