import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { omnirushPluginPath } from "./omnirush-extensions-plugin-path.js";

function withPluginDir(value: string | undefined, fn: () => void) {
  const previous = process.env.OMNIRUSH_EXTENSIONS_PLUGIN_DIR;
  if (value === undefined) {
    delete process.env.OMNIRUSH_EXTENSIONS_PLUGIN_DIR;
  } else {
    process.env.OMNIRUSH_EXTENSIONS_PLUGIN_DIR = value;
  }

  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env.OMNIRUSH_EXTENSIONS_PLUGIN_DIR;
    } else {
      process.env.OMNIRUSH_EXTENSIONS_PLUGIN_DIR = previous;
    }
  }
}

function restoreResourcesPath(previous: string | undefined) {
  if (previous === undefined) {
    delete process.resourcesPath;
  } else {
    process.resourcesPath = previous;
  }
}

describe("omnirushPluginPath", () => {
  test("prefers OMNIRUSH_EXTENSIONS_PLUGIN_DIR", () => {
    withPluginDir("/opt/omnirush/opencode-plugins", () => {
      const resourcesPath = join("/Applications", "OmniRush.ai.app", "Contents", "Resources");
      const previousResourcesPath = process.resourcesPath;
      process.resourcesPath = resourcesPath;
      try {
        expect(omnirushPluginPath("omnirush-extensions-preview", join(resourcesPath, "app.asar", "server", "dist")))
          .toBe(join("/opt/omnirush/opencode-plugins", "omnirush-extensions-preview.js"));
      } finally {
        restoreResourcesPath(previousResourcesPath);
      }
    });
  });

  test("uses external resources plugin path in packaged Electron when env is unset", () => {
    withPluginDir(undefined, () => {
      const previousResourcesPath = process.resourcesPath;
      const resourcesPath = join("/Applications", "OmniRush.ai.app", "Contents", "Resources");
      process.resourcesPath = resourcesPath;
      try {
        const pluginPath = omnirushPluginPath(
          "omnirush-extensions-preview",
          join(resourcesPath, "app.asar", "server", "dist"),
        );

        expect(pluginPath).toBe(join(resourcesPath, "opencode-plugins", "omnirush-extensions-preview.js"));
        expect(pluginPath).not.toContain("app.asar");
      } finally {
        restoreResourcesPath(previousResourcesPath);
      }
    });
  });

  test("uses source plugin path in development when env is unset", () => {
    withPluginDir(undefined, () => {
      const here = join("/repo", "apps", "server", "src");
      expect(omnirushPluginPath("omnirush-extensions-preview", here))
        .toBe(join(here, "opencode-plugins", "omnirush-extensions-preview.ts"));
    });
  });
});
