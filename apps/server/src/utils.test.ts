import { describe, expect, test } from "bun:test";
import { hashToken, shortId, parseList, ensureDir, exists } from "./utils.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("hashToken", () => {
  test("returns consistent hash for same input", () => {
    const a = hashToken("my-secret-token");
    const b = hashToken("my-secret-token");
    expect(a).toBe(b);
  });

  test("returns different hashes for different inputs", () => {
    const a = hashToken("token-a");
    const b = hashToken("token-b");
    expect(a).not.toBe(b);
  });

  test("returns a hex string", () => {
    const hash = hashToken("test");
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  // Regression tests for HMAC-SHA-256 pepper fix (CWE-916)
  test("hash is NOT plain SHA-256 (pepper is applied)", () => {
    // Plain SHA-256 of "test" is well-known; HMAC with pepper must differ
    const { createHash } = require("node:crypto");
    const plainSha256 = createHash("sha256").update("test").digest("hex");
    const hmacResult = hashToken("test");
    expect(hmacResult).not.toBe(plainSha256);
  });

  test("hash length is 64 hex chars (SHA-256 output)", () => {
    const hash = hashToken("any-token");
    expect(hash.length).toBe(64);
  });
});

describe("shortId", () => {
  test("returns a non-empty string", () => {
    const id = shortId();
    expect(id.length).toBeGreaterThan(0);
  });

  test("returns unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => shortId()));
    expect(ids.size).toBe(100);
  });
});

describe("parseList", () => {
  test("splits comma-separated values", () => {
    expect(parseList("a,b,c")).toEqual(["a", "b", "c"]);
  });

  test("trims whitespace", () => {
    expect(parseList(" a , b , c ")).toEqual(["a", "b", "c"]);
  });

  test("filters empty entries", () => {
    expect(parseList("a,,b,")).toEqual(["a", "b"]);
  });

  test("returns empty array for falsy input", () => {
    expect(parseList(undefined)).toEqual([]);
    expect(parseList("")).toEqual([]);
  });
});

describe("ensureDir + exists", () => {
  test("creates nested directory and reports it exists", async () => {
    const dir = join(tmpdir(), `omnirush-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const nested = join(dir, "a", "b", "c");

    expect(await exists(nested)).toBe(false);
    await ensureDir(nested);
    expect(await exists(nested)).toBe(true);
  });
});
