import type { ImportBrowser, NormalizedCookie } from "./index";

export type SqliteQuery = (sql: string, params?: unknown[]) => Array<Record<string, unknown>>;

export type ChromiumBrowserSpec = {
  label: string;
  keychainService: string;
  darwin: string | null;
  linux: string | null;
  win32: string | null;
};

/** A Linux key ring: `v10` values use the built-in password, `v11` the key ring's; each a key or keys to try in order. */
export type ChromiumKeyRing = { v10?: Buffer | Buffer[]; v11?: Buffer | Buffer[] };
export type ChromiumKey = Buffer | ChromiumKeyRing;

export type ProfileCandidate = {
  /** Stable opaque id such as `chrome:Default` or `firefox:<root-hash>:abc.default-release`. */
  id: string;
  browser: ImportBrowser;
  label: string;
  profile: string;
  /** Absolute path of the cookie database. */
  path: string;
  /** macOS Keychain service holding the encryption password, or null for plaintext stores. */
  keychainService: string | null;
};

export type ReadResult = {
  cookies: NormalizedCookie[];
  /** Rows whose value could not be decrypted (wrong key, app-bound encryption). */
  undecryptable: number;
  version: number | null;
};

export const CHROMIUM_HOST_HASH_MIN_VERSION: 24;
export const CHROMIUM_BROWSERS: Readonly<Record<"chrome" | "edge" | "arc" | "brave" | "vivaldi" | "chromium", ChromiumBrowserSpec>>;

export function chromiumTimeToUnixSeconds(value: number | bigint | string | null | undefined): number | null;
export function deriveChromiumKey(password: string | Buffer, options?: { platform?: NodeJS.Platform | string }): Buffer;
export function decryptChromiumValue(
  encrypted: Buffer | Uint8Array | null | undefined,
  key: ChromiumKey,
  options: { hostKey: string; hashPrefixed: boolean },
): string;
export function chromiumCookieFromRow(
  row: Record<string, unknown>,
  decryptValue: (encrypted: Buffer | Uint8Array, hostKey: string) => string,
): NormalizedCookie;
export function chromiumCookieMetadataFromRow(row: Record<string, unknown>): NormalizedCookie;
export function readChromiumCookieMetadata(query: SqliteQuery): NormalizedCookie[];
export function readChromiumSchemaVersion(query: SqliteQuery): number | null;
export function readChromiumCookies(query: SqliteQuery, options: { key: ChromiumKey | null; version?: number | null; sites?: string[] | null; httpOnlyOnly?: boolean }): ReadResult;
export function firefoxCookieFromRow(row: Record<string, unknown>): NormalizedCookie;
export function firefoxCookieMetadataFromRow(row: Record<string, unknown>): NormalizedCookie;
export function readFirefoxCookieMetadata(query: SqliteQuery): NormalizedCookie[];
export function readFirefoxCookies(query: SqliteQuery, options?: { sites?: string[] | null; httpOnlyOnly?: boolean }): ReadResult;
export function chromiumProfileCandidates(options: { platform: NodeJS.Platform | string; home: string; localAppData?: string | null }): ProfileCandidate[];
export function firefoxProfileCandidates(options: { platform: NodeJS.Platform | string; home: string; appData?: string | null }): ProfileCandidate[];
export function sqliteCompanionFiles(path: string): string[];

/** A browser profile with something to import. Paths stay in the main process. */
export type ImportProfile = {
  /** Same id as the sign-in sync's source for this profile (`chrome:Default`, `firefox:<root>:<dir>`, `safari:Safari`). */
  id: string;
  browser: ImportBrowser;
  label: string;
  /** Directory name (`Default`, `Profile 2`, `abc.default-release`). */
  profile: string;
  /** The name the browser shows for the profile. */
  name: string;
  files: { bookmarks: string | null; history: string | null; cookies: string | null; sidebar: string | null };
  keychainService: string | null;
};

export function chromiumProfileNames(userDataDir: string): Record<string, string>;
export function firefoxProfileNames(profilesIni: string): Record<string, string>;
export function importProfiles(options: { platform: NodeJS.Platform | string; home: string; localAppData?: string | null; appData?: string | null }): ImportProfile[];
