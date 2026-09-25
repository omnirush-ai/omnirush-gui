import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type BackendCatalogModel = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  display_name: string;
  default: boolean;
  reasoning_levels: string[];
  family: string;
  status: string;
  order: number;
  api: string;
  limits: { context: number | null; output: number | null };
  capabilities: Record<string, boolean>;
};

export type BackendCatalogBody = { object: string; catalog_version: string; data: BackendCatalogModel[] };

/**
 * GET /omnirush/v1/models as the backend's catalog serves it to an account
 * with Meta Muse on (rendered from the backend's own catalog code): Astra
 * (default), GPT 6 Sol and GPT-5.6 Sol, then meta-muse-spark, muse-spark-1.1 and muse-spark-1.3
 * (beta, text only). muse-spark-1.2 is unlisted. A fresh copy on every call.
 */
export function backendCatalogBody(): BackendCatalogBody {
  return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "omnirush-model-catalog.json"), "utf8")) as BackendCatalogBody;
}
