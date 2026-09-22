import { test, expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(fileURLToPath(import.meta.url));

// The packaged desktop app excludes server/dist/opencode-plugins/** from the
// app archive (apps/desktop/electron-builder.base.yml) and ships the plugin
// bundles as extra resources instead. A server module that imports from that
// folder therefore resolves in development and breaks the installed app at
// startup ("Cannot find module .../opencode-plugins/<file>.js"). Shared code
// belongs in apps/server/src and is imported by the plugins with "../".
const pluginImport = /from\s+["'](?:\.\/|\.\.\/)?opencode-plugins\//;

async function collect(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("server modules never import from the opencode-plugins folder", async () => {
  const offenders: string[] = [];
  for (const file of await collect(srcDir)) {
    const rel = relative(srcDir, file).split(sep).join("/");
    if (rel.startsWith("opencode-plugins/") || rel.endsWith(".test.ts")) continue;
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (pluginImport.test(line)) offenders.push(`${rel}:${index + 1}`);
    });
  }
  expect(offenders).toEqual([]);
});
