import constants from "../../../constants.json" with { type: "json" };

/**
 * Which engine and harness produced an upload. The same field names and
 * values as the CLI's uploads, so every delivery can say what ran a session:
 * `environment.engine_version` ("opencode/1.18.32-r2"), `environment.harness`
 * and `environment.app_version`.
 */
export type HarnessName = "opencode" | "pi";
export type HarnessEngine = "omnirush-opencode" | "omnirush-core";

export type Harness = {
  name: HarnessName;
  engine: HarnessEngine;
  /** The engine build's version, with its release suffix ("1.18.32-r2"). */
  version: string;
  /** The engine release it came from ("engine-1.18.32-r2"). */
  build_tag: string;
};

const RELEASE_TAG_PREFIX = "engine-";

/** "engine-1.18.32-r2" -> "1.18.32-r2"; a bare version without the tag. */
export function engineBuildVersion(buildTag: string, fallbackVersion: string): string {
  const tag = buildTag.trim();
  if (tag.startsWith(RELEASE_TAG_PREFIX) && tag.length > RELEASE_TAG_PREFIX.length) return tag.slice(RELEASE_TAG_PREFIX.length);
  return fallbackVersion.trim().replace(/^v/, "");
}

/** The desktop's engine: OmniRush.ai's opencode build (apps/desktop/scripts/engine-release.json). */
export function opencodeHarness(buildTag: string, fallbackVersion: string): Harness {
  const version = engineBuildVersion(buildTag, fallbackVersion) || "unknown";
  return {
    name: "opencode",
    engine: "omnirush-opencode",
    version,
    build_tag: buildTag.trim() || `${RELEASE_TAG_PREFIX}${version}`,
  };
}

/** `engine_version` for a harness: "<name>/<version>". */
export function engineVersionOf(harness: Harness): string {
  return `${harness.name}/${harness.version}`;
}

const bundled = constants as { opencodeVersion?: string; engineReleaseTag?: string };

/** The engine this build bundles. */
export const BUNDLED_HARNESS: Harness = Object.freeze(
  opencodeHarness(bundled.engineReleaseTag ?? "", bundled.opencodeVersion ?? ""),
) as Harness;

/** `engine_version` of the bundled engine ("opencode/1.18.32-r2"). */
export const BUNDLED_ENGINE_VERSION = engineVersionOf(BUNDLED_HARNESS);
