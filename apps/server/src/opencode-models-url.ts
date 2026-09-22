import { loopbackFetch } from "./server-fetch.js";

const LOCAL_MODELS_URL = "http://localhost:8791/models";

type ResolveOpencodeModelsUrlOptions = {
  env?: NodeJS.ProcessEnv;
  fetchModels?: (input: string, init?: RequestInit) => Promise<{ ok: boolean }>;
};

/**
 * Model-catalog settings for a spawned engine: either the catalog to refresh
 * from, or the switch that turns catalog refreshes off.
 */
export type OpencodeModelsEnv =
  | { OPENCODE_MODELS_URL: string }
  | { OPENCODE_DISABLE_MODELS_FETCH: "1" };

/**
 * The model catalog a spawned engine should refresh from, or undefined when
 * there is none.
 *
 * The engine re-fetches `${OPENCODE_MODELS_URL}/api.json` every hour and trusts
 * the response as model and provider metadata, provider API base URLs
 * included. omnirush.ai does not host a catalog, so there is no production
 * default: a catalog is used only when OPENCODE_MODELS_URL names one or, in
 * development, when the local inference stack serves one.
 */
export async function resolveOpencodeModelsUrl(
  options: ResolveOpencodeModelsUrlOptions = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const override = env.OPENCODE_MODELS_URL?.trim();
  if (override) return override;
  if (env.OMNIRUSH_DEV_MODE !== "1") return undefined;

  try {
    const response = await (options.fetchModels ?? loopbackFetch)(`${LOCAL_MODELS_URL}/api.json`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) return LOCAL_MODELS_URL;
  } catch {
    // A standalone desktop dev session does not run the local inference stack.
  }

  return undefined;
}

/**
 * Engine environment for the model catalog. Without a catalog the engine is
 * told not to fetch one at all, so it serves the model snapshot bundled in its
 * binary instead of polling a default public catalog host every hour.
 */
export async function resolveOpencodeModelsEnv(
  options: ResolveOpencodeModelsUrlOptions = {},
): Promise<OpencodeModelsEnv> {
  const url = await resolveOpencodeModelsUrl(options);
  return url ? { OPENCODE_MODELS_URL: url } : { OPENCODE_DISABLE_MODELS_FETCH: "1" };
}
