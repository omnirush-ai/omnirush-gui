declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toEqual: (expected: unknown) => void;
};

import {
  BUILTIN_OMNIRUSH_MODEL_IDS,
  DEFAULT_MODEL,
  isOmniRushModelID,
  OMNIRUSH_EXTENSION_CATALOG,
  filterOmniRushExtensionCatalogForPlatform,
  resolveOmniRushExtensionCatalogPlatform,
} from "./constants";

function filteredIds(platform: "darwin" | "linux" | "windows" | "web") {
  return filterOmniRushExtensionCatalogForPlatform(OMNIRUSH_EXTENSION_CATALOG, platform)
    .flatMap((entry) => entry.id ? [entry.id] : []);
}

describe("omnirush.ai extension catalog platform filter", () => {
  test("defaults new conversations to the internal Astra route", () => {
    expect(DEFAULT_MODEL).toEqual({ providerID: "omnirush", modelID: "gpt-6-astra" });
  });

  test("recognises every omnirush.ai catalog model, not just the built-in ones", () => {
    expect([...BUILTIN_OMNIRUSH_MODEL_IDS]).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol"]);
    expect(isOmniRushModelID("gpt-6-sol")).toEqual(true);
    expect(isOmniRushModelID("gpt-5.6-sol")).toEqual(true);
    expect(isOmniRushModelID("GPT-6-Astra")).toEqual(true);
    expect(isOmniRushModelID("meta-muse-spark")).toEqual(true);
    expect(isOmniRushModelID("muse-spark-1.3")).toEqual(true);
    // The launch release's retired route is not a catalog id.
    expect(isOmniRushModelID("z-ai/glm-5.2")).toEqual(false);
    expect(isOmniRushModelID("")).toEqual(false);
  });

  test("resolves browser runtime to web and desktop runtime to OS", () => {
    expect(resolveOmniRushExtensionCatalogPlatform("web", "macos")).toEqual("web");
    expect(resolveOmniRushExtensionCatalogPlatform("desktop", "macos")).toEqual("darwin");
    expect(resolveOmniRushExtensionCatalogPlatform("desktop", "windows")).toEqual("windows");
    expect(resolveOmniRushExtensionCatalogPlatform("desktop", "linux")).toEqual("linux");
  });

  test("hides desktop-only extensions in web", () => {
    expect(filteredIds("web")).toEqual(["ollama"]);
  });

  test("keeps omnirush.ai Browser desktop-only and Computer Use mac-only", () => {
    expect(filteredIds("darwin")).toEqual(["omnirush-browser", "computer-use", "ollama"]);
    expect(filteredIds("linux")).toEqual(["omnirush-browser", "ollama"]);
  });
});
