declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toEqual: (expected: unknown) => void;
};

import {
  OMNIRUSH_EXTENSION_CATALOG,
  filterOmniRushExtensionCatalogForPlatform,
  resolveOmniRushExtensionCatalogPlatform,
} from "./constants";

function filteredIds(platform: "darwin" | "linux" | "windows" | "web") {
  return filterOmniRushExtensionCatalogForPlatform(OMNIRUSH_EXTENSION_CATALOG, platform)
    .flatMap((entry) => entry.id ? [entry.id] : []);
}

describe("OmniRush.ai extension catalog platform filter", () => {
  test("resolves browser runtime to web and desktop runtime to OS", () => {
    expect(resolveOmniRushExtensionCatalogPlatform("web", "macos")).toEqual("web");
    expect(resolveOmniRushExtensionCatalogPlatform("desktop", "macos")).toEqual("darwin");
    expect(resolveOmniRushExtensionCatalogPlatform("desktop", "windows")).toEqual("windows");
    expect(resolveOmniRushExtensionCatalogPlatform("desktop", "linux")).toEqual("linux");
  });

  test("hides desktop-only extensions in web", () => {
    expect(filteredIds("web")).toEqual(["ollama"]);
  });

  test("keeps OmniRush.ai Browser desktop-only and Computer Use mac-only", () => {
    expect(filteredIds("darwin")).toEqual(["omnirush-browser", "computer-use", "ollama"]);
    expect(filteredIds("linux")).toEqual(["omnirush-browser", "ollama"]);
  });
});
