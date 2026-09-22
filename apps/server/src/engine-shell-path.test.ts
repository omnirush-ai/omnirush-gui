import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyEnginePath, enrichedPath, parsePathHelperOutput, pathHelperEntries, wellKnownPathEntries } from "./engine-shell-path.js";

const runtimeSource = readFileSync(path.resolve(import.meta.dir, "../../desktop/electron/runtime.mjs"), "utf8");

/** Render an entry the way runtime.mjs spells it in extraPathEntries(). */
function runtimeSpelling(entry: string, home: string, env: Record<string, string>): string {
  const bases: Array<[string, string]> = [[home, "home"], [env.APPDATA, "process.env.APPDATA"], [env.LOCALAPPDATA, "process.env.LOCALAPPDATA"]];
  for (const [base, name] of bases) {
    if (entry.startsWith(`${base}${path.sep}`)) {
      const parts = entry.slice(base.length + 1).split(path.sep).map((part) => JSON.stringify(part));
      return `path.join(${name}, ${parts.join(", ")})`;
    }
  }
  return JSON.stringify(entry);
}

describe("engine PATH resolution", () => {
  test("lists the same well-known directories as the desktop runtime", () => {
    const home = path.join(tmpdir(), "omnirush-path-home");
    const env = { APPDATA: path.join(tmpdir(), "appdata"), LOCALAPPDATA: path.join(tmpdir(), "localappdata") };
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const entries = wellKnownPathEntries({ platform, home, env, loginShellEntries: [] });
      expect(entries.length).toBeGreaterThan(3);
      for (const entry of entries) {
        const spelling = runtimeSpelling(entry, home, env);
        expect({ platform, entry, spelling, found: runtimeSource.includes(spelling) }).toMatchObject({ found: true });
      }
    }
    expect(wellKnownPathEntries({ platform: "darwin", home, loginShellEntries: ["/usr/bin", "/bin"] }).slice(0, 3))
      .toEqual(["/usr/bin", "/bin", "/opt/homebrew/bin"]);
  });

  test("keeps the inherited PATH first and appends only existing directories once", () => {
    const home = mkdtempSync(path.join(tmpdir(), "omnirush-path-"));
    const localBin = path.join(home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const result = enrichedPath(`/custom/bin${path.delimiter}/usr/bin${path.delimiter}/custom/bin`, {
      platform: "darwin", home, loginShellEntries: ["/usr/bin", "/nonexistent-login-dir"],
    });
    const entries = result?.split(path.delimiter) ?? [];
    expect(entries.slice(0, 2)).toEqual(["/custom/bin", "/usr/bin"]);
    expect(entries.filter((entry) => entry === "/usr/bin")).toHaveLength(1);
    expect(entries).toContain(localBin);
    expect(entries).not.toContain("/nonexistent-login-dir");
    expect(entries).not.toContain(path.join(home, ".cargo", "bin"));
    expect(enrichedPath(undefined, { platform: "win32", home: "/nonexistent-home", env: {} })).toBeNull();
  });

  test("applies to the environment under the platform's PATH key", () => {
    const env: NodeJS.ProcessEnv = { Path: `/x${path.delimiter}/x` };
    expect(applyEnginePath(env, { platform: "win32", home: "/nonexistent-home", env: {} })).toBe("/x");
    expect(env.Path).toBe("/x");
    expect(env.PATH).toBeUndefined();
    const posix: NodeJS.ProcessEnv = { PATH: "/x" };
    expect(applyEnginePath(posix, { platform: "darwin", home: "/nonexistent-home", loginShellEntries: ["/usr/bin"] })?.split(path.delimiter).slice(0, 2))
      .toEqual(["/x", "/usr/bin"]);
  });

  test("parses path_helper output like the desktop runtime", () => {
    expect(parsePathHelperOutput('PATH="/usr/local/bin:/usr/bin:/bin"; export PATH;\n')).toEqual(["/usr/local/bin", "/usr/bin", "/bin"]);
    expect(parsePathHelperOutput("PATH=/usr/bin:/bin; export PATH;\n")).toEqual(["/usr/bin", "/bin"]);
    expect(parsePathHelperOutput("")).toEqual([]);
    if (process.platform === "darwin") expect(pathHelperEntries()).toContain("/usr/bin");
    else expect(pathHelperEntries()).toEqual([]);
  });
});
