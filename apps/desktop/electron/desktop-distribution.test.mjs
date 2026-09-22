import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLOUD_DESKTOP_DISTRIBUTION,
  ENTERPRISE_DESKTOP_DISTRIBUTION,
  PUBLIC_DESKTOP_DISTRIBUTION,
  desktopActivationRequired,
  enterpriseActivationComplete,
  enterprisePreactivationCommandAllowed,
  normalizeAlphaUpdateFeedUrl,
  resolveDesktopDistribution,
} from "./desktop-distribution.mjs";

describe("resolveDesktopDistribution", () => {
  it("brands the local public desktop build as OmniRush.ai", () => {
    assert.deepEqual(PUBLIC_DESKTOP_DISTRIBUTION, {
      flavor: "public",
      appName: "omnirush.ai",
      appIdentifier: "ai.omnirush.desktop",
      protocolScheme: "omnirush",
      requireSignin: false,
      requireActivation: false,
      alphaUpdateFeedUrl: null,
    });
  });

  it("defines a Cloud build that requires sign-in without enterprise activation", () => {
    assert.deepEqual(
      resolveDesktopDistribution({
        isPackaged: true,
        packageFlavor: "cloud",
        environmentFlavor: "enterprise",
      }),
      {
        flavor: "cloud",
        appName: "omnirush.ai Cloud",
        appIdentifier: "ai.omnirush.desktop",
        protocolScheme: "omnirush",
        requireSignin: true,
        requireActivation: false,
        alphaUpdateFeedUrl: null,
      },
    );
  });

  it("uses immutable package metadata for packaged enterprise builds", () => {
    const distribution = resolveDesktopDistribution({
      isPackaged: true,
      packageFlavor: "enterprise",
      environmentFlavor: "public",
    });

    assert.deepEqual(distribution, {
      flavor: "enterprise",
      appName: "omnirush.ai Enterprise",
      appIdentifier: "ai.omnirush.desktop",
      protocolScheme: "omnirush",
      requireSignin: true,
      requireActivation: true,
      alphaUpdateFeedUrl: null,
    });
  });

  it("does not let an environment variable turn a packaged public build into enterprise", () => {
    assert.equal(
      resolveDesktopDistribution({
        isPackaged: true,
        packageFlavor: "public",
        environmentFlavor: "enterprise",
      }).flavor,
      "public",
    );
  });

  it("allows development runs to exercise the enterprise flavor", () => {
    assert.equal(
      resolveDesktopDistribution({
        isPackaged: false,
        packageFlavor: "public",
        environmentFlavor: "enterprise",
      }).flavor,
      "enterprise",
    );
  });

  it("enables an Alpha feed only from immutable package metadata in packaged builds", () => {
    assert.deepEqual(
      resolveDesktopDistribution({
        isPackaged: true,
        packageFlavor: "public",
        environmentFlavor: "public",
        packageAlphaUpdateFeedUrl: "https://updates.example.com/alpha/",
        environmentAlphaUpdateFeedUrl: "https://ignored.example.com/alpha",
      }),
      { ...PUBLIC_DESKTOP_DISTRIBUTION, alphaUpdateFeedUrl: "https://updates.example.com/alpha" },
    );
    assert.equal(
      resolveDesktopDistribution({
        isPackaged: true,
        packageFlavor: "public",
        environmentAlphaUpdateFeedUrl: "https://ignored.example.com/alpha",
      }),
      PUBLIC_DESKTOP_DISTRIBUTION,
    );
    assert.equal(
      resolveDesktopDistribution({
        isPackaged: false,
        packageFlavor: "public",
        environmentAlphaUpdateFeedUrl: "https://dev.example.com/alpha",
      }).alphaUpdateFeedUrl,
      "https://dev.example.com/alpha",
    );
  });

  it("accepts only a plain https feed directory for Alpha updates", () => {
    assert.equal(normalizeAlphaUpdateFeedUrl("https://updates.example.com/alpha/"), "https://updates.example.com/alpha");
    assert.equal(normalizeAlphaUpdateFeedUrl("http://updates.example.com/alpha"), null);
    assert.equal(normalizeAlphaUpdateFeedUrl("https://user:secret@updates.example.com/alpha"), null);
    assert.equal(normalizeAlphaUpdateFeedUrl("https://updates.example.com/alpha?token=1"), null);
    assert.equal(normalizeAlphaUpdateFeedUrl("not a url"), null);
    assert.equal(normalizeAlphaUpdateFeedUrl(""), null);
    assert.equal(normalizeAlphaUpdateFeedUrl(undefined), null);
  });
});

describe("desktopActivationRequired", () => {
  it("uses the distribution default when bootstrap policy is absent", () => {
    assert.equal(desktopActivationRequired(ENTERPRISE_DESKTOP_DISTRIBUTION, {}), true);
    assert.equal(desktopActivationRequired(CLOUD_DESKTOP_DISTRIBUTION, {}), false);
    assert.equal(desktopActivationRequired(PUBLIC_DESKTOP_DISTRIBUTION, {}), false);
  });

  it("keeps the Enterprise artifact authoritative over bootstrap opt-out", () => {
    assert.equal(desktopActivationRequired(
      ENTERPRISE_DESKTOP_DISTRIBUTION,
      { requireActivation: false },
    ), true);
  });

  it("accepts completed activation from the Enterprise bootstrap file", () => {
    assert.equal(desktopActivationRequired(
      ENTERPRISE_DESKTOP_DISTRIBUTION,
      {
        requireActivation: false,
        enterpriseActivation: {
          activatedAt: "2026-07-27T10:00:00.000Z",
          denBaseUrl: "https://enterprise.example.com",
        },
      },
    ), false);
  });

  it("allows desktop-bootstrap.json to enable activation for other distributions", () => {
    assert.equal(desktopActivationRequired(
      PUBLIC_DESKTOP_DISTRIBUTION,
      { requireActivation: true },
    ), true);
  });
});

describe("enterpriseActivationComplete", () => {
  it("requires a persisted activation timestamp and Den URL", () => {
    assert.equal(enterpriseActivationComplete(null), false);
    assert.equal(enterpriseActivationComplete({ enterpriseActivation: {} }), false);
    assert.equal(enterpriseActivationComplete({
      enterpriseActivation: {
        activatedAt: "2026-07-27T10:00:00.000Z",
        denBaseUrl: "https://omnirush.example.com",
      },
    }), true);
  });
});

describe("enterprisePreactivationCommandAllowed", () => {
  it("allows only activation, bootstrap, build metadata, and the Den exchange fetch bridge", () => {
    assert.equal(enterprisePreactivationCommandAllowed("__fetch"), true);
    assert.equal(enterprisePreactivationCommandAllowed("connectLinkAccept"), true);
    assert.equal(enterprisePreactivationCommandAllowed("connectLinkVerify"), true);
    assert.equal(enterprisePreactivationCommandAllowed("getDesktopBootstrapConfig"), true);
    assert.equal(enterprisePreactivationCommandAllowed("setDesktopBootstrapConfig"), true);
    assert.equal(enterprisePreactivationCommandAllowed("appBuildInfo"), true);
    assert.equal(enterprisePreactivationCommandAllowed("engineInfo"), false);
    assert.equal(enterprisePreactivationCommandAllowed("runtimeBootstrap"), false);
    assert.equal(enterprisePreactivationCommandAllowed("terminalCreate"), false);
  });
});
