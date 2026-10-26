import { afterEach, describe, expect, test } from "bun:test";

import { isDesktopProviderBlocked, type DesktopAppRestrictionChecker } from "../src/app/cloud/desktop-app-restrictions";
import { isSupportedModelProvider } from "../src/app/lib/provider-catalog";
import {
  isProviderAllowedByLock,
  isProviderLocked,
  parseProviderLockState,
  providerLockMessage,
  providerLockState,
  setProviderLockState,
} from "../src/app/lib/provider-lock";
import { computePolicyProviderReconcilePlan, reconcilePolicyDisabledProviders } from "../src/react-app/domains/connections/policy-provider-reconcile";
import {
  filterEntitledModelOptions,
  isProviderAddRestrictedByDesktopPolicy,
  isProviderAllowedByDesktopPolicy,
} from "../src/react-app/domains/connections/provider-auth/provider-policy";

const nothingRestricted: DesktopAppRestrictionChecker = () => false;

afterEach(() => setProviderLockState(null));

describe("provider lock in the app", () => {
  test("locked until the server says `locked: false`", () => {
    expect(isProviderLocked()).toBe(true);
    expect(providerLockState().allow).toEqual(["omnirush", "omnirush-claude"]);
    for (const answer of [null, undefined, {}, { locked: "false" }, { locked: 0 }, []]) {
      expect(parseProviderLockState(answer).locked).toBe(true);
    }
    setProviderLockState({ locked: false });
    expect(isProviderLocked()).toBe(false);
    setProviderLockState(null);
    expect(isProviderLocked()).toBe(true);
  });

  test("takes the server's message; only OmniRush's own providers count as allowed", () => {
    setProviderLockState({ locked: true, allow: ["acme", "openai"], message: "Ask your admin." });
    expect(providerLockState()).toEqual({ locked: true, allow: ["omnirush", "omnirush-claude"], message: "Ask your admin." });
    expect(isProviderAllowedByLock("omnirush-claude")).toBe(true);
    expect(providerLockMessage()).toBe("Ask your admin.");
    expect(isProviderAllowedByLock("acme")).toBe(false);
    expect(isProviderAllowedByLock("omnirush")).toBe(true);
  });

  test("model pickers list only OmniRush models while locked, whatever the build flag says", () => {
    expect(isSupportedModelProvider("omnirush", true)).toBe(true);
    for (const id of ["openai", "anthropic", "lpr_team", "opencode", "ollama"]) expect(isSupportedModelProvider(id, true)).toBe(false);
    setProviderLockState({ locked: false });
    expect(isSupportedModelProvider("lpr_team")).toBe(true);
    expect(isSupportedModelProvider("openai", true)).toBe(true);
  });

  test("the organization's allowCustomProviders / allowZenModel cannot let another provider in", () => {
    const options = ["omnirush", "openai", "lpr_team", "opencode"].map((providerID) => ({ providerID, modelID: "m" }));
    expect(filterEntitledModelOptions(options, { restrictToCloud: false, checkRestriction: nothingRestricted }).map((o) => o.providerID)).toEqual(["omnirush"]);
    expect(filterEntitledModelOptions(options, { restrictToCloud: true, checkRestriction: nothingRestricted }).map((o) => o.providerID)).toEqual(["omnirush"]);
    expect(isProviderAllowedByDesktopPolicy({ providerId: "lpr_team", restrictToCloud: true, checkRestriction: nothingRestricted })).toBe(false);
    expect(isDesktopProviderBlocked({ providerId: "opencode", checkRestriction: nothingRestricted })).toBe(true);
    expect(isDesktopProviderBlocked({ providerId: "omnirush", checkRestriction: nothingRestricted })).toBe(false);
  });

  test("adding a provider is restricted while locked, and not when unlocked", () => {
    expect(isProviderAddRestrictedByDesktopPolicy({ checkRestriction: nothingRestricted })).toBe(true);
    expect(isProviderAddRestrictedByDesktopPolicy({ providerId: "openai", checkRestriction: nothingRestricted })).toBe(true);
    setProviderLockState({ locked: false });
    expect(isProviderAddRestrictedByDesktopPolicy({ providerId: "openai", checkRestriction: nothingRestricted })).toBe(false);
  });

  test("the organization reconcile writes nothing while locked", async () => {
    let writes = 0;
    const result = await reconcilePolicyDisabledProviders({
      opencodeClient: null,
      allProviders: [{ id: "openai" }],
      connectedProviderIds: ["openai"],
      disabledProviderIds: [],
      checkRestriction: () => true,
      storage: null,
      setDisabledProviders: () => { writes += 1; },
    });
    expect(result.writes).toBe(0);
    expect(writes).toBe(0);
    setProviderLockState({ locked: false });
    expect(computePolicyProviderReconcilePlan({
      allProviders: [{ id: "openai" }],
      connectedProviderIds: ["openai"],
      disabledProviderIds: [],
      markedDisabledProviderIds: [],
      checkRestriction: ({ restriction }) => restriction === "allowCustomProviders",
    }).toDisable).toEqual(["openai"]);
  });
});
