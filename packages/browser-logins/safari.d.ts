import type { BookmarkNode } from "./bookmarks";
import type { NormalizedCookie } from "./index";
import type { ImportProfile } from "./node";

export type PlistValue = null | boolean | number | string | Date | Buffer | { uid: number } | PlistValue[] | { [key: string]: PlistValue };

export function safariPaths(home: string): { bookmarks: string; history: string; cookies: string[] };
export function isPermissionError(error: unknown): boolean;
export function safariProfile(options: { platform: NodeJS.Platform | string; home: string }): ImportProfile | null;
export function parseBinaryPlist(input: Buffer | Uint8Array): PlistValue;
export function safariBookmarksTree(plist: unknown): BookmarkNode[];
export function parseBinaryCookies(input: Buffer | Uint8Array): NormalizedCookie[];
