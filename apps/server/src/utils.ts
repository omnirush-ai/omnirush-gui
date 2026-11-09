import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function hashToken(token: string): string {
  // Use HMAC-SHA-256 with a fixed application-level pepper to defend against
  // offline brute-force via rainbow tables if the token store is leaked.
  // The pepper is not a secret key—it binds the hash to this application so
  // generic SHA-256 precomputed tables are useless.
  return createHmac("sha256", "omnirush-token-store-v1").update(token).digest("hex");
}

export function shortId(): string {
  return randomUUID();
}

export function parseList(input: string | undefined): string[] {
  if (!input) return [];
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item)).filter(Boolean);
      }
    } catch {
      return [];
    }
  }
  return trimmed
    .split(/[,;]/)
    .map((value) => value.trim())
    .filter(Boolean);
}
