import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Two runtimes consume this package:
 * - bun (dev server, tests, and the plugin bundles built with --target node)
 *   resolves the `bun` / `development` conditions and can execute TypeScript
 *   source directly, so those must point at `src/`.
 * - the packaged desktop app runs the compiled server under Electron's Node,
 *   which refuses to strip types from `.ts` files under node_modules
 *   (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Its `default` condition must
 *   therefore point at the built `dist/` output, which apps/server's build
 *   produces before packaging (v1.0.1 shipped with `default` -> src and the
 *   engine never started).
 */
describe("@omnirush/types package exports", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../../packages/types/package.json"), "utf8"),
  ) as { exports: Record<string, Record<string, string> | string> };

  test("every subpath serves source to bun and built output to Node", () => {
    const wrong = Object.entries(manifest.exports).flatMap(([subpath, target]) => {
      const conditions = typeof target === "string" ? { default: target } : target;
      const problems: string[] = [];
      for (const condition of ["development", "bun"]) {
        const value = conditions[condition];
        if (typeof value !== "string" || !value.startsWith("./src/") || !value.endsWith(".ts")) problems.push(`${condition} must point at src/*.ts`);
      }
      const fallback = conditions.default;
      if (typeof fallback !== "string" || !fallback.startsWith("./dist/") || !fallback.endsWith(".js")) problems.push("default must point at dist/*.js");
      return problems.length > 0 ? [`${subpath}: ${problems.join("; ")}`] : [];
    });
    expect(wrong).toEqual([]);
  });

  test("the runtime subpaths this app imports are declared", () => {
    // Regression anchor: automations is a runtime module (zod schemas), unlike
    // the type-only subpaths that surrounded it when it was introduced.
    expect(manifest.exports["./automations"]).toMatchObject({
      types: "./src/automations.ts",
      bun: "./src/automations.ts",
      default: "./dist/automations.js",
    });
  });
});
