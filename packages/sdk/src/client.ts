import { createClient } from "./gen/client/client.gen.js";
import type { Config } from "./gen/client/types.gen.js";
import { DenClient } from "./gen/sdk.gen.js";

export * from "./gen/types.gen.js";
export { DenClient };

export type DenClientConfig = Config & {
  /**
   * Your Den API origin, e.g. `https://den.example.com`. Required: omnirush.ai
   * runs no hosted Den, so there is no default to fall back to.
   */
  baseUrl: string;
  /** Den user session token. Session-only operations require this credential. */
  token?: string;
  /** Organization API key, sent verbatim in x-api-key. */
  apiKey?: string;
  /** Organization context for organization-scoped operations. */
  orgId?: string;
};

export const MISSING_DEN_BASE_URL_MESSAGE =
  "createDenClient requires an explicit baseUrl (your Den API origin, e.g. https://den.example.com). omnirush.ai runs no hosted Den, so there is no default.";

function requireBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(MISSING_DEN_BASE_URL_MESSAGE);
  const baseUrl = value.trim();
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
  } catch {
    throw new Error(`${MISSING_DEN_BASE_URL_MESSAGE} Received: ${JSON.stringify(baseUrl)}`);
  }
  return baseUrl;
}

export function createDenClient(config: DenClientConfig) {
  const { token, apiKey, orgId, ...options } = config ?? ({} as DenClientConfig);
  const client = createClient({ ...options, baseUrl: requireBaseUrl(options.baseUrl) });
  // Interceptors preserve all supported header forms and per-request overrides.
  client.interceptors.request.use((request) => {
    if (token && !request.headers.has("authorization")) request.headers.set("authorization", `Bearer ${token}`);
    if (apiKey && !request.headers.has("x-api-key")) request.headers.set("x-api-key", apiKey);
    if (orgId && !request.headers.has("x-omnirush-org-id")) request.headers.set("x-omnirush-org-id", orgId);
    return request;
  });
  return new DenClient({ client });
}
