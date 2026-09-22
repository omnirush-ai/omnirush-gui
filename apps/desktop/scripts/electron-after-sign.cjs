const { spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

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

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to notarize the Electron macOS app`);
  }
  return value;
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
  const entitlements = path.join(__dirname, "..", "build", "entitlements.mac.plist");
  run("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", "--options", "runtime", "--entitlements", entitlements, appPath]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  return true;
}

async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  adHocSignIfUnsigned(appPath);

  if (process.env.MACOS_NOTARIZE !== "true") {
    console.warn("[electron-after-sign] MACOS_NOTARIZE is not true; skipping notarization.");
    return;
  }
  verifyComputerUseHelper(appPath, process.env.MACOS_NOTARIZE === "true");

  const notaryTempDir = mkdtempSync(path.join(tmpdir(), "omnirush-electron-notary-"));
  const notaryZipPath = path.join(notaryTempDir, `${context.packager.appInfo.productFilename}-notary.zip`);
  const keyPath = requireEnv("APPLE_API_KEY_PATH");
  const keyId = requireEnv("APPLE_API_KEY");
  const issuer = requireEnv("APPLE_API_ISSUER");

  try {
    run("ditto", ["-c", "-k", "--keepParent", appPath, notaryZipPath]);
    run("xcrun", [
      "notarytool",
      "submit",
      notaryZipPath,
      "--key",
      keyPath,
      "--key-id",
      keyId,
      "--issuer",
      issuer,
      "--wait",
    ]);
    // Notarization tickets can take minutes to propagate to Apple's CDN after acceptance; stapler can transiently fail with status 65 ("CloudKit query failed").
    await runWithRetry("xcrun", ["stapler", "staple", appPath], 5);
    run("xcrun", ["stapler", "validate", appPath]);
  } finally {
    rmSync(notaryTempDir, { recursive: true, force: true });
  }
}

module.exports = afterSign;
module.exports.default = afterSign;
module.exports.runWithRetry = runWithRetry;
module.exports.adHocSignIfUnsigned = adHocSignIfUnsigned;
