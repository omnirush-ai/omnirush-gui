import { expect, test } from "bun:test"
import {
  hasOmniRushWebComplimentaryAccess,
  resolveOmniRushWebAccess,
  setOmniRushWebComplimentaryAccess,
} from "../src/omnirush-web-access.js"

test("complimentary Web access is an explicit metadata grant that preserves unrelated settings", () => {
  const original = {
    brandAppName: "OmniRush.ai Internal",
    capabilities: { installLinks: true },
    complimentaryAccess: { futureProduct: true },
  }
  const granted = setOmniRushWebComplimentaryAccess(original, true)

  expect(hasOmniRushWebComplimentaryAccess(granted)).toBe(true)
  expect(granted).toMatchObject({
    brandAppName: "OmniRush.ai Internal",
    capabilities: { installLinks: true },
    complimentaryAccess: { futureProduct: true, omnirushWeb: true },
  })
  expect(original.complimentaryAccess).toEqual({ futureProduct: true })

  const revoked = setOmniRushWebComplimentaryAccess(granted, false)
  expect(hasOmniRushWebComplimentaryAccess(revoked)).toBe(false)
  expect(revoked).toMatchObject({
    brandAppName: "OmniRush.ai Internal",
    capabilities: { installLinks: true },
    complimentaryAccess: { futureProduct: true },
  })
})

test("revoking the only complimentary grant removes the empty metadata group", () => {
  expect(setOmniRushWebComplimentaryAccess({ complimentaryAccess: { omnirushWeb: true } }, false)).toEqual({})
})

test("complimentary Web access is the only organization grant that overrides the deployment switch", () => {
  expect(resolveOmniRushWebAccess({
    deploymentAvailable: false,
    hasEligibleSubscription: false,
    complimentaryAccess: true,
  })).toEqual({
    hasAccess: true,
    accessSource: "complimentary",
    complimentaryAccess: true,
  })

  expect(resolveOmniRushWebAccess({
    deploymentAvailable: false,
    hasEligibleSubscription: true,
    complimentaryAccess: false,
  })).toEqual({
    hasAccess: false,
    accessSource: null,
    complimentaryAccess: false,
  })
})

test("an eligible paid subscription remains the authoritative source when both grants are present", () => {
  expect(resolveOmniRushWebAccess({
    deploymentAvailable: true,
    hasEligibleSubscription: true,
    complimentaryAccess: true,
  })).toEqual({
    hasAccess: true,
    accessSource: "subscription",
    complimentaryAccess: true,
  })
})
