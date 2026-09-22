declare const afterEach: (fn: () => void | Promise<void>) => void;
declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
};

import { DEFAULT_DEN_BASE_URL, HOSTED_DEFAULT_DEN_BASE_URL, setDenBootstrapConfig } from "../../../app/lib/den";
import {
  hasOmniRushModelsAvailable,
  isOmniRushModelsPromoEligible,
  isOmniRushModelsPromoEligibleForDenBaseUrl,
  shouldShowOmniRushModelsPromo,
  shouldShowOmniRushModelsSyncing,
  wasOmniRushModelsStartupPromoShown,
} from "./omnirush-models-promo";

afterEach(async () => {
  await setDenBootstrapConfig({ baseUrl: DEFAULT_DEN_BASE_URL, requireSignin: false });
});

describe("omnirush.ai Models promo eligibility", () => {
  test("allows promotions on the default Den URL after normalization", () => {
    expect(isOmniRushModelsPromoEligibleForDenBaseUrl(`${HOSTED_DEFAULT_DEN_BASE_URL}/api/den/`)).toBe(true);
  });

  test("suppresses promotions for custom configured Den URLs", async () => {
    await setDenBootstrapConfig({ baseUrl: "https://custom-den.example.com", requireSignin: false });

    expect(isOmniRushModelsPromoEligible()).toBe(false);
    expect(shouldShowOmniRushModelsPromo()).toBe(false);
    expect(wasOmniRushModelsStartupPromoShown()).toBe(true);
  });
});

describe("hasOmniRushModelsAvailable", () => {
  test("requires a connected omnirush provider with at least one model", () => {
    expect(
      hasOmniRushModelsAvailable({
        providerConnectedIds: ["omnirush"],
        providers: [{ id: "omnirush", models: {} }],
      }),
    ).toBe(false);
    expect(
      hasOmniRushModelsAvailable({
        providerConnectedIds: ["omnirush"],
        providers: [{ id: "omnirush", models: { "gpt-5": {} } }],
      }),
    ).toBe(true);
  });
});

describe("shouldShowOmniRushModelsSyncing", () => {
  test("only reports a real pending workspace reload", () => {
    expect(shouldShowOmniRushModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: false,
      reloadPending: true,
    })).toBe(false);
    expect(shouldShowOmniRushModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: true,
      reloadPending: false,
    })).toBe(false);
    expect(shouldShowOmniRushModelsSyncing({
      entitled: true,
      available: false,
      workspaceReady: true,
      reloadPending: true,
    })).toBe(true);
  });
});
