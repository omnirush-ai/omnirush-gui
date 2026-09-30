// Apple notary service helpers shared by the afterSign hook (the .app) and
// scripts/notarize-dmg.mjs (the DMG). Credentials come only from the
// environment, which the release workflows fill from GitHub secrets:
//
//   App Store Connect API key (preferred):
//     APPLE_API_KEY_PATH  path of the AuthKey_<id>.p8 file the workflow wrote
//                         to $RUNNER_TEMP from the APPLE_API_KEY secret
//     APPLE_API_KEY_ID    the key's 10-character ID
//     APPLE_API_ISSUER    the issuer UUID shown above the keys list
//   or Apple ID:
//     APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
//
// Nothing here prints a credential: notarytool gets them as arguments and
// the command line is never echoed.
const { spawnSync } = require("node:child_process");

function present(env, name) {
  return typeof env[name] === "string" && env[name].trim() !== "";
}

/**
 * Returns the notarytool credential arguments, or null when no complete set
 * is configured. A partial set is an error: it means a secret is missing.
 */
function notaryCredentialArgs(env = process.env) {
  const apiNames = ["APPLE_API_KEY_PATH", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"];
  const idNames = ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
  const apiSet = apiNames.filter((name) => present(env, name));
  const idSet = idNames.filter((name) => present(env, name));
  if (apiSet.length === apiNames.length) {
    return {
      kind: "api-key",
      args: ["--key", env.APPLE_API_KEY_PATH, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER],
    };
  }
  if (idSet.length === idNames.length) {
    return {
      kind: "apple-id",
      args: ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID],
    };
  }
  const partial = apiSet.length > 0 ? apiNames.filter((n) => !apiSet.includes(n))
    : idSet.length > 0 ? idNames.filter((n) => !idSet.includes(n))
      : null;
  if (partial) {
    throw new Error(`Incomplete Apple notarization credentials; missing: ${partial.join(", ")}`);
  }
  return null;
}

function runQuiet(command, args, label) {
  // stdio inherited, but the argument list (which holds credentials) is not logged.
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status}`);
}

async function withRetry(fn, attempts, label, baseDelayMs = 30_000) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      const delayMs = baseDelayMs * attempt;
      console.warn(`[apple-notary] ${label} failed (${error.message}); retrying in ${delayMs / 1000}s (attempt ${attempt}/${attempts}).`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Submits a .zip, .dmg or .pkg and waits for Apple's verdict. */
function notarySubmit(filePath, credentials) {
  console.log(`[apple-notary] submitting ${filePath} (${credentials.kind}); waiting for the result...`);
  runQuiet("xcrun", ["notarytool", "submit", filePath, ...credentials.args, "--wait", "--timeout", "2h"], "notarytool submit");
}

/**
 * Staples the ticket and validates it. Tickets can take minutes to reach
 * Apple's CDN after acceptance, so stapler may fail transiently (status 65).
 */
async function stapleAndValidate(targetPath) {
  await withRetry(() => runQuiet("xcrun", ["stapler", "staple", targetPath], "stapler staple"), 5, `stapler staple ${targetPath}`);
  runQuiet("xcrun", ["stapler", "validate", targetPath], "stapler validate");
}

module.exports = { notaryCredentialArgs, notarySubmit, stapleAndValidate, withRetry };
