// Types of model-modes.mjs (the same pair of files in omnirush-cli
// src/model-modes/ and omnirush-gui apps/server/src/model-modes/; PARITY.sha256).

export type ModelMode = "native" | "box";
export type ModeCatalogEntry = { id: string; default?: boolean; display_name?: string; name?: string; modes?: unknown };

export const MODES: readonly ModelMode[];
export const BOX_HEADER: "x-omnirush-box";
export const MODEL_NOT_IN_MODE: "model_not_in_mode";

export function projectMode(box: unknown): ModelMode;
export function modelModes(entry: unknown): ModelMode[];
export function modelAllowedIn(entry: unknown, mode: ModelMode): boolean;
export function modelForMode<T extends ModeCatalogEntry>(catalog: readonly T[] | null | undefined, mode: ModelMode, wanted?: string | null): { model: string | null; models: T[]; note: string | null };
export function modeSwitchNote(from: string, to: string, mode: ModelMode): string;
export function notInModeMessage(mode?: ModelMode | null): string;
export function modeHeaders(box: unknown): Record<string, string>;
export type ServerModelStart = { start: ModelMode; switchable: boolean; revision: string | null };
export function serverModelStart(localBox: unknown, modelId: string | null | undefined): ServerModelStart | null;
