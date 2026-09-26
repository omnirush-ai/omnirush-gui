import { useEffect, useState } from "react";

import type { OmniRushServerClient, OmniRushVoiceStatus } from "@/app/lib/omnirush-server";

type StatusClient = Pick<OmniRushServerClient, "baseUrl" | "getVoiceStatus">;
type Entry = { data: OmniRushVoiceStatus | null; fetchedAt: number; inflight: Promise<void> | null };

const FRESH_MS = 60_000;
const REFRESH_MS = 5 * 60_000;
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function keyOf(client: StatusClient, workspaceId: string | null | undefined): string {
  return `${client.baseUrl}\u0000${workspaceId ?? ""}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function load(client: StatusClient, workspaceId: string | null | undefined, force = false): Promise<void> {
  const key = keyOf(client, workspaceId);
  const entry = entries.get(key) ?? { data: null, fetchedAt: 0, inflight: null };
  entries.set(key, entry);
  if (entry.inflight) return entry.inflight;
  if (!force && entry.data && Date.now() - entry.fetchedAt < FRESH_MS) return Promise.resolve();
  entry.inflight = client.getVoiceStatus(workspaceId ?? null)
    .then((data) => {
      entry.data = data;
    }, () => {
      // Unknown: keep the last answer; the mic stays usable and the first upload decides.
    })
    .finally(() => {
      entry.fetchedAt = Date.now();
      entry.inflight = null;
      notify();
    });
  return entry.inflight;
}

/** The last known voice status for this server and workspace (null until the first answer). */
export function peekVoiceStatus(client: StatusClient | null, workspaceId: string | null | undefined): OmniRushVoiceStatus | null {
  return client ? entries.get(keyOf(client, workspaceId))?.data ?? null : null;
}

/** Asks the server again (after a refusal that may have changed availability). */
export function refreshVoiceStatus(client: StatusClient | null, workspaceId: string | null | undefined): void {
  if (client) void load(client, workspaceId, true);
}

/**
 * GET /omnirush/voice/status, cached per server and workspace for a minute
 * and refreshed every five, shared by every composer and Settings → Voice.
 */
export function useVoiceStatus(client: StatusClient | null, workspaceId: string | null | undefined, enabled = true): OmniRushVoiceStatus | null {
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (!client || !enabled) return;
    const listener = () => setVersion((version) => version + 1);
    listeners.add(listener);
    void load(client, workspaceId);
    const timer = setInterval(() => void load(client, workspaceId), REFRESH_MS);
    return () => {
      listeners.delete(listener);
      clearInterval(timer);
    };
  }, [client, enabled, workspaceId]);
  return enabled ? peekVoiceStatus(client, workspaceId) : null;
}
