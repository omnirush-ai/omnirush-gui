const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { notaryCredentialArgs, notarySubmit, stapleAndValidate } = require("./apple-notary.cjs");

const computerUseHelperAppName = "OmniRush.ai Computer Use.app";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
}

async function runWithRetry(command, args, attempts, baseDelayMs = 30_000) {
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.status === 0) return;
    if (attempt >= attempts) {
      throw new Error(`${command} ${args.join(" ")} failed with status ${result.status} after ${attempts} attempts`);
    }
    const delayMs = baseDelayMs * attempt;
    console.warn(
      `[electron-after-sign] ${command} ${args.join(" ")} failed with status ${result.status}; retrying in ${delayMs / 1000}s (attempt ${attempt}/${attempts}).`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function computerUseHelperPath(appPath) {
  return path.join(appPath, "Contents", "Resources", "helpers", computerUseHelperAppName);
}

function verifyComputerUseHelper(appPath, requireDistributionSignature) {
  const helperPath = computerUseHelperPath(appPath);
  if (!existsSync(helperPath)) {
    throw new Error(`Computer Use helper app is missing from packaged app: ${helperPath}`);
  }

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", helperPath]);

  if (!requireDistributionSignature) return;
  const result = spawnSync("codesign", ["--display", "--verbose=4", helperPath], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`codesign --display failed for Computer Use helper with status ${result.status}`);
  }
  if (result.stderr.includes("Signature=adhoc")) {
    throw new Error("Computer Use helper app is ad-hoc signed; notarized builds require a Developer ID signature.");
  }
}


/**
 * Release builds run without a Developer ID certificate. electron-builder then
 * leaves the bundle with only the linker's per-binary ad-hoc signature and no
 * sealed resources, which Gatekeeper reports as "damaged and can't be opened".
 * A proper ad-hoc deep signature turns that into the ordinary unidentified
 * developer prompt (right-click > Open, or allow in Privacy & Security).
 */
function adHocSignIfUnsigned(appPath) {
  const display = spawnSync("codesign", ["--display", "--verbose=2", appPath], { encoding: "utf8" });
  const info = `${display.stdout || ""}${display.stderr || ""}`;
  const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", appPath], { encoding: "utf8" });
  const developerSigned = /Authority=Developer ID Application/.test(info);
  if (developerSigned && verify.status === 0) return false;
  if (verify.status === 0 && !/linker-signed/.test(info)) return false;
  console.warn("[electron-after-sign] no Developer ID signature found; applying an ad-hoc deep signature so Gatekeeper does not report the app as damaged.");
  // The inherit set: ad-hoc code has no Team ID, so library validation must be
  // off for the app to load its own frameworks and addons.
  const entitlements = path.join(__dirname, "..", "build", "entitlements.mac.inherit.plist");
  run("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", "--options", "runtime", "--entitlements", entitlements, appPath]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  return true;
}

function isDeveloperIdSigned(appPath) {
  const display = spawnSync("codesign", ["--display", "--verbose=2", appPath], { encoding: "utf8" });
  return /Authority=Developer ID Application/.test(`${display.stdout || ""}${display.stderr || ""}`);
}

async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  adHocSignIfUnsigned(appPath);

  if (!isDeveloperIdSigned(appPath)) {
    console.warn("[electron-after-sign] the app is not Developer ID signed (no MAC_CSC_LINK secret); skipping notarization.");
    return;
  }
  if (process.env.MACOS_NOTARIZE === "false") {
    console.warn("[electron-after-sign] MACOS_NOTARIZE=false; skipping notarization of a Developer ID signed app.");
    return;
  }
  verifyComputerUseHelper(appPath, true);

  const credentials = notaryCredentialArgs();
  if (!credentials) {
    // A Developer ID signature without a notarization ticket still fails
    // Gatekeeper on first launch, so never produce one silently.
    throw new Error(
      "The app is Developer ID signed but no notarization credentials are set "
      + "(APPLE_API_KEY_PATH/APPLE_API_KEY_ID/APPLE_API_ISSUER or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID). "
      + "Set MACOS_NOTARIZE=false to build a signed, un-notarized app on purpose.",
    );
  }

  const notaryTempDir = mkdtempSync(path.join(tmpdir(), "omnirush-electron-notary-"));
  const notaryZipPath = path.join(notaryTempDir, `${context.packager.appInfo.productFilename}-notary.zip`);
  try {
    run("ditto", ["-c", "-k", "--keepParent", appPath, notaryZipPath]);
    notarySubmit(notaryZipPath, credentials);
    // The zip electron-builder makes next (the in-app update payload) then
    // carries the stapled app, so it opens offline too.
    await stapleAndValidate(appPath);
  } finally {
    rmSync(notaryTempDir, { recursive: true, force: true });
  }
}

module.exports = afterSign;
module.exports.default = afterSign;
module.exports.runWithRetry = runWithRetry;
module.exports.adHocSignIfUnsigned = adHocSignIfUnsigned;
