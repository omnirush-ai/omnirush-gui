// Types of provider-lock.mjs (the same pair of files in omnirush-cli
// src/provider-lock/ and omnirush-gui apps/server/src/provider-lock/; PARITY.sha256).

export const OMNIRUSH_PROVIDER_ID: "omnirush";
export const APP_PROVIDER_IDS: readonly ["omnirush", "omnirush-claude"];
export const PROVIDER_LOCK_MESSAGE: string;
export const PLUGINS_OFF_MESSAGE: string;
export const PROVIDER_ID_PATTERN: RegExp;
export const ENGINE_CONFIG_INJECTION_ENV: readonly string[];

export type ProviderLockPolicy = {
  locked: boolean;
  /** Allowed provider ids, "omnirush" first; empty when unlocked. */
  allow: string[];
  message: string;
  source: "default" | "missing" | "server";
};

export function lockedProviderPolicy(source?: ProviderLockPolicy["source"]): ProviderLockPolicy;
export function providerLockPolicy(capabilities: unknown): ProviderLockPolicy;
export function modelProvider(ref: unknown): string | null;
export function modelRefAllowed(policy: ProviderLockPolicy | null | undefined, ref: unknown): boolean;
export function providerLockEnv(policy?: ProviderLockPolicy | null): { set: Record<string, string>; remove: string[] };
export function withProviderLockEnv<T extends Record<string, string | undefined>>(env: T, policy: ProviderLockPolicy | null | undefined): Record<string, string | undefined>;
export function lockEngineConfig<T>(config: T, policy: ProviderLockPolicy | null | undefined): { config: T; removed: string[] };
