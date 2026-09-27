#!/usr/bin/env node
/**
 * Decides how a desktop build is signed from the signing secrets the workflow
 * passes in as environment variables, and prepares what electron-builder
 * needs. It never prints a secret value, only which names are set.
 *
 *   macOS    Developer ID Application certificate (MAC_CSC_LINK, a base64
 *            .p12, + MAC_CSC_KEY_PASSWORD) and notarization credentials
 *            (APPLE_API_KEY = the .p8 key text or its base64, APPLE_API_KEY_ID,
 *            APPLE_API_ISSUER; or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD,
 *            APPLE_TEAM_ID).
 *   Windows  Azure Trusted Signing (AZURE_TENANT_ID, AZURE_CLIENT_ID,
 *            AZURE_CLIENT_SECRET, AZURE_TRUSTED_SIGNING_ENDPOINT,
 *            AZURE_TRUSTED_SIGNING_ACCOUNT, AZURE_TRUSTED_SIGNING_PROFILE,
 *            WIN_PUBLISHER_NAME), preferred when complete, or a PFX
 *            (WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD).
 *   Linux    not signed.
 *
 * With none of a platform's secrets the build is unsigned, as forks and PR
 * CI need. A partial set is an error. With --enforce and a 3.x or later
 * version, an unsigned macOS or Windows build is an error: a 3.x release is
 * never published unsigned.
 *
 * Usage:
 *   node scripts/signing-plan.mjs --platform macos|windows|linux|all
 *        [--version X.Y.Z] [--enforce]
 *
 * In GitHub Actions it writes step outputs: signed, mode, and for macOS
 * apple_api_key_path, for Windows builder_args_file (a JSON list of
 * electron-builder -c overrides, kept in a file because step outputs that
 * contain secret values are dropped by the runner).
 */
import { appendFileSync, chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAC_CERT = ["MAC_CSC_LINK", "MAC_CSC_KEY_PASSWORD"];
export const MAC_NOTARY_API = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];
export const MAC_NOTARY_ID = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
export const WIN_AZURE = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT",
  "AZURE_TRUSTED_SIGNING_PROFILE",
  "WIN_PUBLISHER_NAME",
];
export const WIN_PFX = ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"];

const RELEASE_SIGNING_MAJOR = 3;

function isSet(env, name) {
  return typeof env[name] === "string" && env[name].trim() !== "";
}

function group(env, names) {
  const set = names.filter((name) => isSet(env, name));
  return {
    complete: set.length === names.length,
    empty: set.length === 0,
    missing: names.filter((name) => !set.includes(name)),
  };
}

export function majorVersion(version) {
  const match = /^v?(\d+)\./.exec(String(version ?? "").trim());
  return match ? Number(match[1]) : null;
}

/** Pure decision; see the file comment. Returns { signed, mode, errors, notes, ... }. */
export function planPlatform(platform, env) {
  const errors = [];
  const notes = [];
  if (platform === "macos") {
    const cert = group(env, MAC_CERT);
    const api = group(env, MAC_NOTARY_API);
    const id = group(env, MAC_NOTARY_ID);
    if (!api.empty && !api.complete) errors.push(`macOS notarization (API key) is missing ${api.missing.join(", ")}`);
    if (!id.empty && !id.complete) errors.push(`macOS notarization (Apple ID) is missing ${id.missing.join(", ")}`);
    if (!cert.empty && !cert.complete) errors.push(`macOS signing is missing ${cert.missing.join(", ")}`);
    const notary = api.complete ? "api-key" : id.complete ? "apple-id" : null;
    if (cert.complete && !notary && errors.length === 0) {
      errors.push(`macOS signing has a certificate but no notarization credentials (${MAC_NOTARY_API.join(", ")} or ${MAC_NOTARY_ID.join(", ")})`);
    }
    if (!cert.complete && notary && errors.length === 0) {
      errors.push(`macOS notarization credentials are set but the Developer ID certificate is missing (${cert.missing.join(", ")})`);
    }
    const signed = errors.length === 0 && cert.complete && Boolean(notary);
    if (!signed && errors.length === 0) notes.push(`no macOS signing secrets (${MAC_CERT.join(", ")}): ad-hoc signed, not notarized`);
    return { platform, signed, mode: signed ? `developer-id+notary-${notary}` : "unsigned", notary, errors, notes };
  }
  if (platform === "windows") {
    const azure = group(env, WIN_AZURE);
    const pfx = group(env, WIN_PFX);
    if (azure.complete) {
      if (!pfx.empty) notes.push("both Azure Trusted Signing and PFX secrets are set; using Azure Trusted Signing");
      return { platform, signed: true, mode: "azure-trusted-signing", errors, notes };
    }
    if (pfx.complete) {
      if (!azure.empty) notes.push(`Azure Trusted Signing is incomplete (missing ${azure.missing.join(", ")}); using the PFX`);
      return { platform, signed: true, mode: "pfx", errors, notes };
    }
    if (!azure.empty) errors.push(`Windows Azure Trusted Signing is missing ${azure.missing.join(", ")}`);
    if (!pfx.empty) errors.push(`Windows PFX signing is missing ${pfx.missing.join(", ")}`);
    if (errors.length === 0) notes.push(`no Windows signing secrets (${WIN_AZURE[0]}... or ${WIN_PFX.join(", ")}): unsigned`);
    return { platform, signed: false, mode: "unsigned", errors, notes };
  }
  if (platform === "linux") {
    return { platform, signed: false, mode: "not-applicable", errors, notes: ["Linux packages are not code signed"] };
  }
  return { platform, signed: false, mode: "unknown", errors: [`unknown platform ${platform}`], notes };
}

export function enforceRelease(plan, version) {
  const major = majorVersion(version);
  if (plan.platform === "linux" || major === null || major < RELEASE_SIGNING_MAJOR) return [];
  if (plan.signed) return [];
  const names = plan.platform === "macos"
    ? `${MAC_CERT.join(", ")} and ${MAC_NOTARY_API.join(", ")} (or ${MAC_NOTARY_ID.join(", ")})`
    : `${WIN_AZURE.join(", ")} (or ${WIN_PFX.join(", ")})`;
  return [`${version} is a ${RELEASE_SIGNING_MAJOR}.x+ release and ${plan.platform} would be unsigned; add the GitHub secrets ${names}. See docs/release-signing.md.`];
}

/** electron-builder -c overrides for Windows. Values are not secret but may be stored as secrets. */
export function windowsBuilderArgs(plan, env) {
  if (plan.mode === "azure-trusted-signing") {
    return [
      `-c.win.azureSignOptions.publisherName=${env.WIN_PUBLISHER_NAME.trim()}`,
      `-c.win.azureSignOptions.endpoint=${env.AZURE_TRUSTED_SIGNING_ENDPOINT.trim()}`,
      `-c.win.azureSignOptions.codeSigningAccountName=${env.AZURE_TRUSTED_SIGNING_ACCOUNT.trim()}`,
      `-c.win.azureSignOptions.certificateProfileName=${env.AZURE_TRUSTED_SIGNING_PROFILE.trim()}`,
    ];
  }
  if (plan.mode === "pfx" && isSet(env, "WIN_PUBLISHER_NAME")) {
    // Otherwise electron-builder takes the certificate's common name.
    return [`-c.win.signtoolOptions.publisherName=${env.WIN_PUBLISHER_NAME.trim()}`];
  }
  return [];
}

/** APPLE_API_KEY holds the .p8 text or its base64; notarytool needs a file. */
export function decodeApiKey(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.includes("BEGIN PRIVATE KEY")) return `${trimmed}\n`;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  if (!decoded.includes("BEGIN PRIVATE KEY")) {
    throw new Error("APPLE_API_KEY is neither the AuthKey_<id>.p8 text nor its base64");
  }
  return decoded.endsWith("\n") ? decoded : `${decoded}\n`;
}

function readArg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const platformArg = readArg(args, "--platform");
  const version = readArg(args, "--version");
  const enforce = args.includes("--enforce");
  const platforms = platformArg === "all" ? ["macos", "windows"] : [platformArg];
  const env = process.env;
  const failures = [];
  for (const platform of platforms) {
    const plan = planPlatform(platform, env);
    const problems = [...plan.errors, ...(enforce ? enforceRelease(plan, version) : [])];
    console.log(`[signing-plan] ${platform}: ${plan.signed ? "SIGNED" : "UNSIGNED"} (${plan.mode})`);
    for (const note of plan.notes) console.log(`[signing-plan]   ${note}`);
    for (const problem of problems) console.error(`[signing-plan]   ERROR: ${problem}`);
    failures.push(...problems);
    if (platforms.length !== 1 || problems.length > 0) continue;

    output("signed", String(plan.signed));
    output("mode", plan.mode);
    const runnerTemp = process.env.RUNNER_TEMP || tmpdir();
    if (platform === "macos" && plan.signed && plan.notary === "api-key") {
      const dir = mkdtempSync(path.join(runnerTemp, "apple-notary-"));
      const keyPath = path.join(dir, `AuthKey_${env.APPLE_API_KEY_ID.trim()}.p8`);
      writeFileSync(keyPath, decodeApiKey(env.APPLE_API_KEY), { mode: 0o600 });
      chmodSync(keyPath, 0o600);
      output("apple_api_key_path", keyPath);
    }
    if (platform === "windows") {
      const file = path.join(runnerTemp, "omnirush-win-signing-args.json");
      writeFileSync(file, JSON.stringify(windowsBuilderArgs(plan, env)));
      output("builder_args_file", file);
    }
  }
  if (failures.length > 0) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
