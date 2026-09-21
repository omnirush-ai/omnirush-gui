import { resolveEvalEngineValue } from "@omnirush/hosts/eval-engine";
import type { EvalEngine } from "@omnirush/hosts/eval-engine";

export type { EvalEngine } from "@omnirush/hosts/eval-engine";

export function resolveEvalEngine(env: NodeJS.ProcessEnv = process.env): EvalEngine {
  return resolveEvalEngineValue(env.OMNIRUSH_EVAL_ENGINE);
}
