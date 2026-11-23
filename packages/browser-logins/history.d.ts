import type { SqliteQuery } from "./node";

export type HistoryEntry = { url: string; title: string; visits: number; lastVisitAt: number };
export type HistoryOptions = { since?: number; limit?: number };

export const HISTORY_DAYS: 90;
export const HISTORY_LIMIT: 25000;
export const APPLE_EPOCH_OFFSET_S: 978307200;

export function historySince(now?: number, days?: number): number;
export function readChromiumHistory(query: SqliteQuery, options?: HistoryOptions): HistoryEntry[];
export function countChromiumHistory(query: SqliteQuery, options?: HistoryOptions): number;
export function readFirefoxHistory(query: SqliteQuery, options?: HistoryOptions): HistoryEntry[];
export function countFirefoxHistory(query: SqliteQuery, options?: HistoryOptions): number;
export function readSafariHistory(query: SqliteQuery, options?: HistoryOptions): HistoryEntry[];
export function countSafariHistory(query: SqliteQuery, options?: HistoryOptions): number;
