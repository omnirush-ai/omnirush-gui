import { browserScript } from "@omnirush/cdp";
import { evalIn } from "@omnirush/behaviors";
import type { Surface, EvaluateOptions } from "@omnirush/cdp";
export type InPageOptions = EvaluateOptions;

/** Execute a checked browser callback with one explicit argument. */
export function inPage<A, R>(surface: Surface, callback: (args: A) => R, args: A, options: InPageOptions = {}): Promise<Awaited<R>> {
  return evalIn(surface, browserScript(callback, [args]), options);
}
