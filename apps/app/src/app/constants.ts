import type { ModelRef, SuggestedPlugin } from "./types";
import { t } from "../i18n";
import { getDenMcpUrl } from "./lib/den";
import { canonicalMcpServerName } from "./mcp";
import {
  BUILT_IN_OMNIRUSH_EXTENSION_MANIFESTS,
  extensionContribution,
  extensionResource,
  isTrustedBuiltInExtension,
  type OmniRushExtensionManifest,
  type OmniRushExtensionPlatform,
} from "./extensions";

export const MODEL_PREF_KEY = "omnirush.defaultModel";
export const SESSION_MODEL_PREF_KEY = "omnirush.sessionModels";
export const THINKING_PREF_KEY = "omnirush.showThinking";
export const VARIANT_PREF_KEY = "omnirush.modelVariant";
export { LANGUAGE_PREF_KEY } from "../i18n";
export const HIDE_TITLEBAR_PREF_KEY = "omnirush.hideTitlebar";

/**
 * The models the engine serves before the account's catalog first syncs (and
 * offline); the first entry is the default. The catalog itself comes from the
 * server, so any other catalog model is just as valid.
 */
export const BUILTIN_OMNIRUSH_MODEL_IDS = ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol"] as const;

export const DEFAULT_MODEL: ModelRef = {
  providerID: "omnirush",
  modelID: BUILTIN_OMNIRUSH_MODEL_IDS[0],
};

/** omnirush.ai model ids the catalog no longer serves; a stored choice of one resets to the default. */
export const RETIRED_OMNIRUSH_MODEL_IDS: readonly string[] = [];

/** The id syntax of the omnirush.ai model catalog. */
const OMNIRUSH_CATALOG_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Whether a model id can name an omnirush.ai catalog model. Retired routes
 * (e.g. the launch release's `z-ai/glm-5.2`) cannot.
 */
export function isOmniRushModelID(modelID: string): boolean {
  const id = modelID.trim();
  return OMNIRUSH_CATALOG_MODEL_ID.test(id) && !RETIRED_OMNIRUSH_MODEL_IDS.includes(id.toLowerCase());
}

/**
 * Every effort an omnirush.ai model may offer, in picker order. Each model
 * offers its own subset: the server's runtime config declares the rest of
 * these disabled, so the engine reports exactly the model's levels.
 */
export const OMNIRUSH_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const SUGGESTED_PLUGINS: SuggestedPlugin[] = [];

export type ExtensionKind = "mcp" | "plugin" | "skill" | "ui-control" | "extension";

export type McpDirectoryInfo = {
  id?: string;
  /** Display name shown in the UI. */
  name: string;
  /** Safe server name for opencode.jsonc (alphanumeric, - and _ only). Auto-derived from name if omitted. */
  serverName?: string;
  description: string;
  url?: string;
  type?: "remote" | "local";
  command?: string[];
  oauth: boolean;
  /** Route OAuth through the local omnirush.ai gateway instead of delegating it to OpenCode. */
  managedOAuth?: boolean;
  /** Identifies MCP entries owned by omnirush.ai Connect instead of workspace configuration. */
  managedBy?: "omnirush-connect";
  oauthConfig?: {
    clientId?: string;
    clientSecret?: string;
    scope?: string;
  };
  /** Extension category for UI grouping. Defaults to "mcp". */
  kind?: ExtensionKind;
  /** Simple Icons slug for brand icon (e.g. "notion", "stripe", "figma"). */
  iconSlug?: string;
  /** Direct icon URL (e.g. local SVG). Takes priority over iconSlug. */
  iconSrc?: string;
  /** Prompt inserted from the composer extension picker. */
  composerPrompt?: string;
  /** Whether omnirush.ai should show this extension as enabled before user setup. */
  defaultEnabled?: boolean;
  /** Whether omnirush.ai should hide this extension from the default catalog view. */
  defaultHidden?: boolean;
  /** Whether this extension is still in preview. */
  preview?: boolean;
  /** Normalized extension manifest backing this catalog entry. */
  extensionManifest?: OmniRushExtensionManifest;
};

function extensionManifestToDirectoryInfo(manifest: OmniRushExtensionManifest): McpDirectoryInfo {
  const mcpResource = extensionResource(manifest, "mcp");
  return {
    id: manifest.id,
    name: manifest.name,
    serverName: mcpResource?.mcpServerName ?? manifest.id,
    description: manifest.description,
    type: mcpResource?.command ? "local" : undefined,
    command: mcpResource?.command,
    oauth: false,
    kind: "extension",
    iconSlug: manifest.icon?.simpleIconSlug,
    iconSrc: manifest.icon?.src,
    composerPrompt: extensionContribution(manifest, "composer-prompt")?.prompt ?? manifest.composer?.prompt,
    defaultEnabled: manifest.defaultEnabled,
    defaultHidden: manifest.defaultHidden,
    preview: manifest.preview,
    extensionManifest: manifest,
  };
}

export function isBuiltInOmniRushExtension(entry: Pick<McpDirectoryInfo, "kind" | "extensionManifest">): boolean {
  return entry.kind === "extension" && isTrustedBuiltInExtension(entry.extensionManifest);
}

/** Derive a safe MCP server name from a display name or explicit serverName. */
export function getMcpServerName(entry: McpDirectoryInfo): string {
  if (entry.serverName) return entry.serverName;
  return canonicalMcpServerName(entry.name);
}

export const MCP_QUICK_CONNECT: McpDirectoryInfo[] = [
  {
    get name() { return t("mcp.quick_connect_notion_title"); },
    serverName: "notion",
    get description() { return t("mcp.quick_connect_notion_desc"); },
    url: "https://mcp.notion.com/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "notion",
    iconSrc: "/ext-notion.svg",
  },
  {
    get name() { return t("mcp.quick_connect_linear_title"); },
    serverName: "linear",
    get description() { return t("mcp.quick_connect_linear_desc"); },
    url: "https://mcp.linear.app/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "linear",
    iconSrc: "/ext-linear.svg",
  },
  {
    get name() { return t("mcp.quick_connect_sentry_title"); },
    serverName: "sentry",
    get description() { return t("mcp.quick_connect_sentry_desc"); },
    url: "https://mcp.sentry.dev/mcp",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "sentry",
    iconSrc: "/ext-sentry.svg",
  },
  {
    get name() { return t("mcp.quick_connect_stripe_title"); },
    serverName: "stripe",
    get description() { return t("mcp.quick_connect_stripe_desc"); },
    url: "https://mcp.stripe.com",
    type: "remote",
    oauth: true,
    kind: "mcp",
    iconSlug: "stripe",
    iconSrc: "/ext-stripe.svg",
  },
  {
    get name() { return t("mcp.quick_connect_context7_title"); },
    serverName: "context7",
    get description() { return t("mcp.quick_connect_context7_desc"); },
    url: "https://mcp.context7.com/mcp",
    type: "remote",
    oauth: false,
    kind: "mcp",
    iconSlug: "semanticscholar",
    iconSrc: "/ext-context7.svg",
  },
  {
    get name() { return t("mcp.quick_connect_omnirush_cloud_title"); },
    serverName: "omnirush-cloud",
    get description() { return t("mcp.quick_connect_omnirush_cloud_desc"); },
    get url() {
      // The desktop app connects to the minimal, harness-facing surface
      // (/mcp/agent: search_capabilities + execute_capability only), not the
      // full catalog at bare /mcp. getDenMcpUrl heals stale web-app origins;
      // never at the web app's root (see
      // packages/docs/cloud/run-in-the-cloud/cloud-mcp.mdx).
      try {
        const mcpUrl = getDenMcpUrl();
        return mcpUrl ? `${mcpUrl}/agent` : "";
      } catch {
        return "";
      }
    },
    type: "remote",
    oauth: true,
    managedBy: "omnirush-connect",
    kind: "mcp",
    iconSrc: "/omnirush-mark.png",
    // Auto-managed by the signed-in cloud reconciler (syncCloudControlMcp):
    // configured + enabled while signed in to omnirush.ai Cloud. Hidden from the
    // default catalog; "Show hidden" reveals it.
    defaultHidden: true,
  },
  {
    get name() { return t("mcp.quick_connect_omnirush_ui_title"); },
    serverName: "omnirush-ui",
    get description() { return t("mcp.quick_connect_omnirush_ui_desc"); },
    type: "local",
    // Resolved by the desktop at connect time (getOmniRushUiMcpCommand): the
    // MCP ships inside the app and runs under the app's own binary. It is not
    // published on npm, so there is deliberately no `npx` fallback here.
    command: [],
    oauth: false,
    kind: "ui-control",
    iconSrc: "/omnirush-mark.png",
    // Internal UI-control surface for agents driving the desktop app. Hidden
    // from the default catalog; "Show hidden" reveals it.
    defaultHidden: true,
  },
  ...BUILT_IN_OMNIRUSH_EXTENSION_MANIFESTS.map(extensionManifestToDirectoryInfo),
];

export const OMNIRUSH_EXTENSION_CATALOG = MCP_QUICK_CONNECT.filter((entry) => entry.kind === "extension");

export function resolveOmniRushExtensionCatalogPlatform(
  platform: "web" | "desktop",
  os?: "macos" | "windows" | "linux",
): OmniRushExtensionPlatform {
  if (platform === "web") return "web";
  if (os === "macos") return "darwin";
  if (os === "windows") return "windows";
  return "linux";
}

export function filterOmniRushExtensionCatalogForPlatform<TEntry extends Pick<McpDirectoryInfo, "extensionManifest">>(
  entries: TEntry[],
  platform: OmniRushExtensionPlatform,
): TEntry[] {
  return entries.filter((entry) => {
    const platforms = entry.extensionManifest?.platform;
    return !platforms || platforms.includes(platform);
  });
}
