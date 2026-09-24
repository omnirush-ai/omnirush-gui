import { describe, expect, test } from "bun:test";

import {
  directoryMatchKey,
  EmptySessionDirectoryCache,
  isSessionListRequest,
  listSessionsByDirectory,
  serveSessionListWithFallback,
  sessionListFallbackQuery,
  type GlobalSessionPage,
} from "./session-list-fallback.js";

function session(id: string, directory: string, updated: number) {
  return { id, directory, parentID: undefined, title: id, time: { created: updated, updated }, project: { id: "p", worktree: directory } };
}

/** The engine's global index: newest first, `cursor` = last item's time.updated. */
function globalIndex(items: ReturnType<typeof session>[]) {
  const calls: URLSearchParams[] = [];
  const fetchPage = async (params: URLSearchParams): Promise<GlobalSessionPage> => {
    calls.push(params);
    const limit = Number(params.get("limit"));
    const cursor = params.get("cursor");
    const sorted = [...items].sort((left, right) => right.time.updated - left.time.updated);
    const eligible = cursor ? sorted.filter((item) => item.time.updated < Number(cursor)) : sorted;
    const page = eligible.slice(0, limit);
    const more = eligible.length > limit && page.length > 0;
    return { items: page, nextCursor: more ? String(page[page.length - 1]!.time.updated) : null };
  };
  return { fetchPage, calls };
}

describe("directoryMatchKey", () => {
  test("Windows folders compare case-insensitively across slash styles, prefixes and trailing separators", () => {
    const current = "C:\\Users\\vedant\\Desktop\\RepoRadar";
    for (const stored of [
      "C:/Users/vedant/Desktop/reporadar",
      "c:/users/vedant/desktop/RepoRadar/",
      "\\\\?\\C:\\Users\\vedant\\Desktop\\RepoRadar",
      "C:\\Users\\vedant\\\\Desktop\\RepoRadar\\",
    ]) {
      expect(directoryMatchKey(stored, "win32")).toBe(directoryMatchKey(current, "win32"));
    }
  });

  test("Windows keeps different folders, drives and UNC shares apart", () => {
    const key = directoryMatchKey("C:\\Users\\vedant\\taskforge", "win32");
    expect(directoryMatchKey("D:\\Users\\vedant\\taskforge", "win32")).not.toBe(key);
    expect(directoryMatchKey("C:\\Users\\vedant\\taskforge2", "win32")).not.toBe(key);
    expect(directoryMatchKey("\\\\?\\UNC\\server\\share\\repo", "win32")).toBe(directoryMatchKey("\\\\server\\share\\repo", "win32"));
    expect(directoryMatchKey("\\\\server\\share\\repo", "win32")).not.toBe(directoryMatchKey("C:\\share\\repo", "win32"));
    expect(directoryMatchKey("C:\\", "win32")).toBe("c:/");
  });

  test("Linux stays case-sensitive; macOS default volumes do not", () => {
    expect(directoryMatchKey("/home/a/Repo", "linux")).not.toBe(directoryMatchKey("/home/a/repo", "linux"));
    expect(directoryMatchKey("/home/a/repo/", "linux")).toBe(directoryMatchKey("/home/a/repo", "linux"));
    expect(directoryMatchKey("/Users/a/RepoRadar", "darwin")).toBe(directoryMatchKey("/Users/a/reporadar", "darwin"));
    expect(directoryMatchKey("/", "linux")).toBe("/");
  });
});

describe("session list request detection", () => {
  test("only the bare list is served with the fallback", () => {
    expect(isSessionListRequest("GET", "/session")).toBe(true);
    expect(isSessionListRequest("POST", "/session")).toBe(false);
    expect(isSessionListRequest("GET", "/session/status")).toBe(false);
    expect(isSessionListRequest("GET", "/session/ses_1")).toBe(false);
  });

  test("the query mirrors the list's roots, start, search and limit", () => {
    expect(sessionListFallbackQuery("?limit=200&directory=C%3A%5Cx")).toEqual({ roots: undefined, start: undefined, search: undefined, limit: 200 });
    expect(sessionListFallbackQuery("?roots=true&start=5&search=%20fix%20")).toEqual({ roots: true, start: 5, search: "fix", limit: 100 });
  });
});

describe("listSessionsByDirectory", () => {
  test("finds a re-cased Windows folder's sessions across pages and drops the project join", async () => {
    const items = [
      ...Array.from({ length: 700 }, (_, index) => session(`other_${index}`, "C:/Users/vedant/helm", 10_000 - index)),
      session("ses_old_case", "C:/Users/vedant/reporadar", 1_000),
      session("ses_new_case", "C:/Users/vedant/RepoRadar", 2_000),
    ];
    const index = globalIndex(items);
    const result = await listSessionsByDirectory({
      fetchPage: index.fetchPage,
      directories: ["C:\\Users\\vedant\\RepoRadar"],
      query: { limit: 200 },
      platform: "win32",
    });
    expect(result.map((item) => item.id)).toEqual(["ses_new_case", "ses_old_case"]);
    expect(result[0]).not.toHaveProperty("project");
    expect(index.calls).toHaveLength(2);
    expect(index.calls[0]!.get("archived")).toBe("true");
  });

  test("stops at the limit and at the scan budget", async () => {
    const items = Array.from({ length: 50 }, (_, index) => session(`ses_${index}`, "/w", 100 - index));
    const limited = await listSessionsByDirectory({ fetchPage: globalIndex(items).fetchPage, directories: ["/w"], query: { limit: 3 }, platform: "linux" });
    expect(limited.map((item) => item.id)).toEqual(["ses_0", "ses_1", "ses_2"]);

    const index = globalIndex(Array.from({ length: 2_000 }, (_, index) => session(`x_${index}`, "/other", 5_000 - index)));
    const none = await listSessionsByDirectory({ fetchPage: index.fetchPage, directories: ["/w"], query: { limit: 10 }, platform: "linux", maxScanned: 1_000 });
    expect(none).toEqual([]);
    expect(index.calls).toHaveLength(2);
  });
});

function delayed<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("serveSessionListWithFallback", () => {
  const indexed = [{ id: "ses_a", directory: "C:/w" }];

  test("a quick non-empty engine answer passes through untouched", async () => {
    let fallbackCalls = 0;
    const response = await serveSessionListWithFallback({
      primary: Promise.resolve(Response.json([{ id: "ses_engine" }])),
      fallback: async () => { fallbackCalls += 1; return indexed; },
      deadlineMs: 1_000,
    });
    expect(await response.json()).toEqual([{ id: "ses_engine" }]);
    expect(fallbackCalls).toBe(0);
  });

  test("an instance still booting past the deadline is answered from the index", async () => {
    const events: string[] = [];
    const response = await serveSessionListWithFallback({
      primary: delayed(Response.json([{ id: "late" }]), 200),
      fallback: async (cause) => { events.push(cause); return indexed; },
      deadlineMs: 10,
      onFallback: ({ cause, count }) => events.push(`${cause}:${count}`),
    });
    expect(await response.json()).toEqual(indexed);
    expect(events).toEqual(["slow", "slow:1"]);
  });

  test("an empty engine answer for a folder whose sessions live under another spelling uses the index", async () => {
    const response = await serveSessionListWithFallback({
      primary: Promise.resolve(Response.json([])),
      fallback: async (cause) => (cause === "empty" ? indexed : []),
      deadlineMs: 1_000,
    });
    expect(await response.json()).toEqual(indexed);
  });

  test("a truly empty folder stays empty", async () => {
    const response = await serveSessionListWithFallback({
      primary: Promise.resolve(Response.json([])),
      fallback: async () => [],
      deadlineMs: 1_000,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test("a failed engine request is answered from the index, or rethrown when the index fails too", async () => {
    const answered = await serveSessionListWithFallback({
      primary: Promise.reject(new Error("fetch failed")),
      fallback: async () => indexed,
      deadlineMs: 1_000,
    });
    expect(await answered.json()).toEqual(indexed);

    const failure = new Error("engine down");
    await expect(serveSessionListWithFallback({
      primary: Promise.reject(failure),
      fallback: async () => { throw new Error("index down"); },
      deadlineMs: 1_000,
    })).rejects.toBe(failure);
  });

  test("a slow engine still wins when the index fails", async () => {
    const response = await serveSessionListWithFallback({
      primary: delayed(Response.json([{ id: "late" }]), 30),
      fallback: async () => { throw new Error("index down"); },
      deadlineMs: 5,
    });
    expect(await response.json()).toEqual([{ id: "late" }]);
  });

  test("an engine error status is replaced by the index answer", async () => {
    const response = await serveSessionListWithFallback({
      primary: Promise.resolve(Response.json({ error: "boot failed" }, { status: 500 })),
      fallback: async () => indexed,
      deadlineMs: 1_000,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(indexed);
  });
});

describe("EmptySessionDirectoryCache", () => {
  test("remembers an empty folder for the TTL only", () => {
    let now = 0;
    const cache = new EmptySessionDirectoryCache(() => now, 1_000);
    cache.remember("c:/w");
    expect(cache.has("c:/w")).toBe(true);
    now = 1_001;
    expect(cache.has("c:/w")).toBe(false);
  });
});
