// Session-route adapter for the provider-auth store's `omnirushServer` slice.
//
// The settings route feeds the store the full omnirush-server store, whose
// snapshot carries the server's real capabilities (including `providerSync`)
// and host-token auth. The session route used to fabricate a snapshot with
// hard-coded `{ config }` capabilities and no auth at all, so on the app's
// default surface `serverHandlesProviderSync()` was permanently false:
// PUT /den-session never fired after sign-in, the local server never learned
// the Den session, and server-side cloud provider sync never started (#3671).
//
// This adapter reports the truth for the endpoint it wraps:
// - local endpoints (the desktop's own OmniRush.ai server) advertise
//   `providerSync: true` — every OmniRush.ai server does
//   (apps/server/src/types.ts `Capabilities.providerSync: true`) — and carry
//   the live host token so the store can PUT /den-session and
//   POST /cloud-provider-sync/run;
// - remote workspaces keep the previous conservative shape (config only): a
//   desktop must not push its Den session to a shared remote worker.
import {
  createOmniRushServerClient,
  isLoopbackOmniRushServerUrl,
  readOmniRushServerSettings,
  type OmniRushServerClient,
} from "@/app/lib/omnirush-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { ProviderAuthOmniRushServer } from "./store";

type SessionOmniRushServerSnapshot = ReturnType<ProviderAuthOmniRushServer["getSnapshot"]>;

export type CreateSessionOmniRushServerInput = {
  endpoint: () => ResolvedWorkspaceEndpoint | null;
  /** Live host token from the desktop runtime (omnirushServerInfo). */
  hostToken?: () => string;
};

function resolveHostToken(endpoint: ResolvedWorkspaceEndpoint, live: string): string {
  if (live) return live;
  // Fallback mirrors omnirush-server-store's getAuth(): persisted settings may
  // hold the host token (ensureDesktopLocalOmniRushConnection writes it), but
  // only trust it for loopback servers — host tokens never travel off-machine.
  if (!isLoopbackOmniRushServerUrl(endpoint.baseUrl)) return "";
  return readOmniRushServerSettings().hostToken?.trim() ?? "";
}

export function createSessionOmniRushServer(
  input: CreateSessionOmniRushServerInput,
): ProviderAuthOmniRushServer {
  let clientCacheKey = "";
  let clientCacheValue: OmniRushServerClient | null = null;

  const hostAwareClient = (endpoint: ResolvedWorkspaceEndpoint, hostToken: string): OmniRushServerClient => {
    if (!hostToken) return endpoint.client;
    const key = `${endpoint.baseUrl}\u001f${endpoint.token}\u001f${hostToken}`;
    if (key !== clientCacheKey || !clientCacheValue) {
      clientCacheKey = key;
      clientCacheValue = createOmniRushServerClient({
        baseUrl: endpoint.baseUrl,
        token: endpoint.token || undefined,
        hostToken,
      });
    }
    return clientCacheValue;
  };

  return {
    getSnapshot: (): SessionOmniRushServerSnapshot => {
      const endpoint = input.endpoint();
      if (!endpoint) {
        return {
          omnirushServerStatus: "disconnected",
          omnirushServerClient: null,
          omnirushServerCapabilities: null,
        };
      }
      if (endpoint.isRemote) {
        return {
          omnirushServerStatus: "connected",
          omnirushServerClient: endpoint.client,
          omnirushServerCapabilities: { config: { read: true, write: true } },
        };
      }
      const hostToken = resolveHostToken(endpoint, input.hostToken?.().trim() ?? "");
      return {
        omnirushServerStatus: "connected",
        omnirushServerClient: hostAwareClient(endpoint, hostToken),
        omnirushServerAuth: {
          token: endpoint.token || undefined,
          hostToken: hostToken || undefined,
        },
        omnirushServerCapabilities: {
          config: { read: true, write: true },
          providerSync: true,
        },
      };
    },
  };
}
