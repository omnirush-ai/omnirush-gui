import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeApiKey,
  enforceRelease,
  majorVersion,
  planPlatform,
  windowsBuilderArgs,
} from "./signing-plan.mjs";

const macCert = { MAC_CSC_LINK: "cert", MAC_CSC_KEY_PASSWORD: "pw" };
const macApi = { APPLE_API_KEY: "key", APPLE_API_KEY_ID: "ABC123DEFG", APPLE_API_ISSUER: "issuer" };
const macId = { APPLE_ID: "a@b.c", APPLE_APP_SPECIFIC_PASSWORD: "pw", APPLE_TEAM_ID: "TEAM" };
const azure = {
  AZURE_TENANT_ID: "t",
  AZURE_CLIENT_ID: "c",
  AZURE_CLIENT_SECRET: "s",
  AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
  AZURE_TRUSTED_SIGNING_ACCOUNT: "omnirush",
  AZURE_TRUSTED_SIGNING_PROFILE: "omnirush-public",
  WIN_PUBLISHER_NAME: "OmniRush Example Ltd",
};
const pfx = { WIN_CSC_LINK: "pfx", WIN_CSC_KEY_PASSWORD: "pw" };

describe("signing plan", () => {
  it("builds unsigned without any secrets, and that passes outside 3.x releases", () => {
    for (const platform of ["macos", "windows"]) {
      const plan = planPlatform(platform, {});
      assert.equal(plan.signed, false);
      assert.deepEqual(plan.errors, []);
      assert.deepEqual(enforceRelease(plan, "2.2.2"), []);
    }
  });

  it("refuses an unsigned macOS or Windows build for a 3.x or later release", () => {
    for (const platform of ["macos", "windows"]) {
      assert.equal(enforceRelease(planPlatform(platform, {}), "3.0.0").length, 1);
      assert.equal(enforceRelease(planPlatform(platform, {}), "v4.1.0-rc.1").length, 1);
    }
    assert.deepEqual(enforceRelease(planPlatform("linux", {}), "3.0.0"), []);
  });

  it("signs and notarizes macOS with either credential set", () => {
    assert.equal(planPlatform("macos", { ...macCert, ...macApi }).mode, "developer-id+notary-api-key");
    assert.equal(planPlatform("macos", { ...macCert, ...macId }).mode, "developer-id+notary-apple-id");
    assert.deepEqual(enforceRelease(planPlatform("macos", { ...macCert, ...macApi }), "3.0.0"), []);
  });

  it("treats a partial macOS set as a misconfiguration", () => {
    assert.equal(planPlatform("macos", macCert).errors.length, 1);
    assert.equal(planPlatform("macos", macApi).errors.length, 1);
    assert.equal(planPlatform("macos", { ...macCert, APPLE_API_KEY_ID: "x" }).signed, false);
    assert.ok(planPlatform("macos", { MAC_CSC_LINK: "cert", ...macApi }).errors.length > 0);
  });

  it("prefers Azure Trusted Signing and falls back to a PFX", () => {
    const both = planPlatform("windows", { ...azure, ...pfx });
    assert.equal(both.mode, "azure-trusted-signing");
    assert.equal(planPlatform("windows", pfx).mode, "pfx");
    assert.equal(planPlatform("windows", { ...pfx, AZURE_TENANT_ID: "t" }).mode, "pfx");
    assert.equal(planPlatform("windows", { AZURE_TENANT_ID: "t" }).errors.length, 1);
    assert.equal(planPlatform("windows", { WIN_CSC_LINK: "x" }).errors.length, 1);
  });

  it("passes the Azure account to electron-builder and keeps one publisher name", () => {
    const args = windowsBuilderArgs(planPlatform("windows", azure), azure);
    assert.ok(args.includes("-c.win.azureSignOptions.publisherName=OmniRush Example Ltd"));
    assert.ok(args.includes("-c.win.azureSignOptions.codeSigningAccountName=omnirush"));
    assert.deepEqual(windowsBuilderArgs(planPlatform("windows", pfx), pfx), []);
    assert.deepEqual(
      windowsBuilderArgs(planPlatform("windows", pfx), { ...pfx, WIN_PUBLISHER_NAME: "X" }),
      ["-c.win.signtoolOptions.publisherName=X"],
    );
  });

  it("reads the release major version", () => {
    assert.equal(majorVersion("v3.0.0"), 3);
    assert.equal(majorVersion("2.2.2"), 2);
    assert.equal(majorVersion("garbage"), null);
  });

  it("accepts the notary key as .p8 text or base64", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    assert.equal(decodeApiKey(pem), `${pem}\n`);
    assert.equal(decodeApiKey(Buffer.from(pem).toString("base64")), `${pem}\n`);
    assert.throws(() => decodeApiKey("bm90IGEga2V5"));
  });
});
