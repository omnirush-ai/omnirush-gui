export const PUBLIC_DESKTOP_DISTRIBUTION = Object.freeze({
  flavor: "public",
  appName: "omnirush.ai",
  appIdentifier: "ai.omnirush.desktop",
  protocolScheme: "omnirush",
  requireSignin: false,
  requireActivation: false,
  // GitHub releases publish stable manifests only, so the public build has no
  // Alpha feed. A distribution enables the Alpha channel by shipping an https
  // feed directory in its package metadata (see resolveDesktopDistribution).
  alphaUpdateFeedUrl: null,
});

export const CLOUD_DESKTOP_DISTRIBUTION = Object.freeze({
  flavor: "cloud",
  appName: "omnirush.ai Cloud",
  appIdentifier: "ai.omnirush.desktop",
  protocolScheme: "omnirush",
  requireSignin: true,
  requireActivation: false,
  alphaUpdateFeedUrl: null,
});

export const ENTERPRISE_DESKTOP_DISTRIBUTION = Object.freeze({
  flavor: "enterprise",
  appName: "omnirush.ai Enterprise",
  appIdentifier: "ai.omnirush.desktop",
  protocolScheme: "omnirush",
  requireSignin: true,
  requireActivation: true,
  alphaUpdateFeedUrl: null,
});

function normalizeFlavor(value) {
  const flavor = value?.trim().toLowerCase();
  return flavor === "cloud" || flavor === "enterprise" ? flavor : "public";
}

/**
 * An Alpha feed is the directory electron-updater reads `latest*.yml` from
 * (for example `https://example.com/releases/alpha`). Only an https directory
 * without credentials or query parameters is accepted; anything else leaves
 * the Alpha channel disabled so the updater never probes a dead feed.
 */
export function normalizeAlphaUpdateFeedUrl(value) {
  const feedUrl = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (!feedUrl) return null;
  try {
    const url = new URL(feedUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return null;
    }
  } catch {
    return null;
  }
  return feedUrl;
}

/**
 * Packaged builds trust only electron-builder's immutable package metadata.
 * The environment overrides exist solely so development and coded evals can
 * exercise the enterprise gate or an Alpha feed without producing a signed
 * installer.
 */
export function resolveDesktopDistribution({
  isPackaged,
  packageFlavor,
  environmentFlavor = undefined,
  packageAlphaUpdateFeedUrl = undefined,
  environmentAlphaUpdateFeedUrl = undefined,
}) {
  const flavor = normalizeFlavor(
    isPackaged ? packageFlavor : (environmentFlavor || packageFlavor),
  );
  const distribution = flavor === "cloud"
    ? CLOUD_DESKTOP_DISTRIBUTION
    : flavor === "enterprise"
      ? ENTERPRISE_DESKTOP_DISTRIBUTION
      : PUBLIC_DESKTOP_DISTRIBUTION;
  const alphaUpdateFeedUrl = normalizeAlphaUpdateFeedUrl(
    isPackaged ? packageAlphaUpdateFeedUrl : (environmentAlphaUpdateFeedUrl || packageAlphaUpdateFeedUrl),
  );
  return alphaUpdateFeedUrl ? Object.freeze({ ...distribution, alphaUpdateFeedUrl }) : distribution;
}

export function enterpriseActivationComplete(config) {
  if (!config || typeof config !== "object") return false;
  const activation = config.enterpriseActivation;
  return Boolean(
    activation
    && typeof activation === "object"
    && typeof activation.activatedAt === "string"
    && activation.activatedAt.trim()
    && typeof activation.denBaseUrl === "string"
    && activation.denBaseUrl.trim(),
  );
}

export function desktopActivationRequired(distribution, config) {
  const requireActivation = distribution.flavor === "enterprise"
    ? distribution.requireActivation
    : (typeof config?.requireActivation === "boolean"
        ? config.requireActivation
        : distribution.requireActivation);
  return requireActivation && !enterpriseActivationComplete(config);
}

const ENTERPRISE_PREACTIVATION_COMMANDS = new Set([
  "__fetch",
  "appBuildInfo",
  "connectLinkAccept",
  "connectLinkVerify",
  "getDesktopBootstrapConfig",
  "setDesktopBootstrapConfig",
]);

export function enterprisePreactivationCommandAllowed(command) {
  return ENTERPRISE_PREACTIVATION_COMMANDS.has(command);
}
