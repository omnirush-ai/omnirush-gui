import type { SqliteQuery } from "./node";

export type BookmarkNode =
  | { kind: "folder"; title: string; children: BookmarkNode[]; addedAt: number | null }
  | { kind: "url"; title: string; url: string; addedAt: number | null };

export type BookmarkRow = {
  parent: number | null;
  position: number;
  kind: "folder" | "url";
  title: string;
  url: string | null;
  addedAt: number | null;
};

export const BOOKMARK_MAX_DEPTH: 32;
export const BOOKMARK_MAX_NODES: 50000;

export function importableUrl(value: unknown): string | null;
export function countBookmarks(nodes: BookmarkNode[]): number;
export function parseChromiumBookmarks(text: string): BookmarkNode[];
export function readFirefoxBookmarks(query: SqliteQuery): BookmarkNode[];
export function parseArcSidebar(text: string): BookmarkNode[];
export function flattenBookmarks(nodes: BookmarkNode[]): BookmarkRow[];
