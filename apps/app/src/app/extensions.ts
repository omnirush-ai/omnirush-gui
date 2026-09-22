// Owned here: reload vocabulary is part of the extension manifest contract.
// types.ts re-exports it for the rest of the app.
export type ReloadReason = "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";

export type OmniRushExtensionSourceFormat =
  | "agent-plugin"
  | "omnirush-builtin"
  | "omnirush-extension-manifest"
  | "claude-plugin"
  | "opencode-plugin"
  | "mcp-directory"
  | "manual";

export type OmniRushExtensionSource = {
  format: OmniRushExtensionSourceFormat;
  trusted: boolean;
  origin?: "builtin" | "den" | "workspace" | "local";
  reference?: string;
};

export type OmniRushExtensionResourceType =
  | "skill"
  | "agent"
  | "command"
  | "tool"
  | "mcp"
  | "opencode-plugin"
  | "provider"
  | "hook"
  | "context"
  | "secret"
  | "file"
  | "local-service"
  | "native-binary";

export type OmniRushExtensionResource = {
  type: OmniRushExtensionResourceType;
  id: string;
  label?: string;
  description?: string;
  path?: string;
  command?: string[];
  envKey?: string;
  packageName?: string;
  providerId?: string;
  mcpServerName?: string;
  localCommandRef?: "omnirush.computerUseMcp" | "omnirush.uiMcp";
  required?: boolean;
};

export type OmniRushExtensionContributionType =
  | "settings-panel"
  | "setup-instructions"
  | "composer-prompt"
  | "session-side-panel"
  | "session-rail-item"
  | "control-actions"
  | "server-route"
  | "native-capability"
  | "test-action";

export type OmniRushExtensionContribution = {
  type: OmniRushExtensionContributionType;
  ref?: string;
  label?: string;
  description?: string;
  prompt?: string;
  location?: "settings-detail" | "composer" | "session-right-pane" | "session-rail" | "server" | "native";
};

export type OmniRushExtensionSetup = {
  instructions?: string;
  primaryCta?: string;
  secondaryCta?: string;
  requiredEnv?: string[];
  testActionRef?: string;
};

export type OmniRushExtensionLifecycle = {
  reload?: ReloadReason[];
  detection?: string[];
};

// ---------------------------------------------------------------------------
// Enablement — declarative conditions for extension "active" state
// ---------------------------------------------------------------------------

export type EnablementConditionType =
  | "mcp-connected"
  | "plugin-loaded"
  | "provider-connected"
  | "env-set"
  | "permission-granted"
  | "toggle-enabled";

export type EnablementCondition = {
  type: EnablementConditionType;
  /** What to check — MCP server name, plugin id, env key, etc. */
  ref: string;
  /** Human-readable label shown in the UI. */
  label: string;
};

/** Result of evaluating a single enablement condition at runtime. */
export type EnablementResult = {
  condition: EnablementCondition;
  met: boolean;
};

export type OmniRushExtensionManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  preview?: boolean;
  source: OmniRushExtensionSource;
  icon?: {
    src?: string;
    simpleIconSlug?: string;
  };
  composer?: {
    prompt: string;
  };
  setup?: OmniRushExtensionSetup;
  resources: OmniRushExtensionResource[];
  contributions?: OmniRushExtensionContribution[];
  lifecycle?: OmniRushExtensionLifecycle;
  /** Declarative conditions that must ALL be true for the extension to be "active". */
  enablement?: EnablementCondition[];
  defaultEnabled?: boolean;
  defaultHidden?: boolean;
  platform?: Array<"darwin" | "linux" | "windows" | "web">;
};

export type OmniRushExtensionPlatform = NonNullable<OmniRushExtensionManifest["platform"]>[number];

export function extensionContribution(
  manifest: OmniRushExtensionManifest | undefined,
  type: OmniRushExtensionContributionType,
): OmniRushExtensionContribution | undefined {
  return manifest?.contributions?.find((contribution) => contribution.type === type);
}

export function extensionResource(
  manifest: OmniRushExtensionManifest | undefined,
  type: OmniRushExtensionResourceType,
): OmniRushExtensionResource | undefined {
  return manifest?.resources.find((resource) => resource.type === type);
}

export function isTrustedBuiltInExtension(manifest: OmniRushExtensionManifest | undefined): boolean {
  return manifest?.source.origin === "builtin" && manifest.source.trusted;
}

export const BUILT_IN_OMNIRUSH_EXTENSION_MANIFESTS: OmniRushExtensionManifest[] = [
  {
    schemaVersion: 1,
    id: "omnirush-browser",
    name: "omnirush.ai Browser",
    description: "Automate the built-in browser panel that stays visible inside omnirush.ai.",
    source: { format: "omnirush-builtin", origin: "builtin", trusted: true },
    icon: { src: "/omnirush-mark.png" },
    composer: { prompt: "Use the omnirush.ai Browser extension to " },
    setup: {
      instructions: "omnirush.ai Browser is ready by default in desktop workspaces.",
    },
    resources: [
      {
        type: "opencode-plugin",
        id: "opencode-chrome-devtools",
        packageName: "opencode-chrome-devtools",
        required: true,
      },
    ],
    contributions: [
      { type: "settings-panel", ref: "omnirush.browser.settings", location: "settings-detail" },
      { type: "session-side-panel", ref: "omnirush.browser.panel", location: "session-right-pane" },
      { type: "composer-prompt", prompt: "Use the omnirush.ai Browser extension to ", location: "composer" },
    ],
    enablement: [
      { type: "toggle-enabled", ref: "omnirush-browser", label: "Enabled" },
    ],
    lifecycle: { reload: ["plugins", "agents"], detection: ["plugin:opencode-chrome-devtools"] },
    defaultEnabled: true,
    platform: ["darwin", "linux", "windows"],
  },
  {
    schemaVersion: 1,
    id: "computer-use",
    name: "Computer Use",
    description: "Work in the Mac app and window you approve. Read, use accessible controls, or allow mouse and keyboard control with a small window preview.",
    preview: true,
    source: { format: "omnirush-builtin", origin: "builtin", trusted: true },
    icon: { src: "/omnirush-mark.png" },
    composer: { prompt: "Use Computer Use to " },
    setup: {
      instructions: "Computer Use is available on macOS 14 or later. Grant Accessibility and Screen Recording in the helper. For each session, choose an app window and allow reading, app controls, or mouse and keyboard. Choose Allow and start in omnirush.ai. Your input interrupts control; Stop in the preview ends access.",
      primaryCta: "Enable Computer Use",
      secondaryCta: "Check macOS permissions",
      testActionRef: "omnirush.computerUse.healthCheck",
    },
    resources: [
      {
        type: "mcp",
        id: "computer-use-mcp",
        label: "Computer Use MCP",
        mcpServerName: "computer-use",
        command: [],
        localCommandRef: "omnirush.computerUseMcp",
        required: true,
      },
      {
        type: "native-binary",
        id: "computer-use-native",
        label: "Computer Use session runtime",
        packageName: "@omnirush/computer-use",
        required: true,
      },
    ],
    contributions: [
      { type: "setup-instructions", ref: "omnirush.computerUse.setup", label: "Setup instructions", location: "settings-detail" },
      { type: "native-capability", ref: "omnirush.computerUse.axPermissions", label: "Accessibility and Screen Recording" },
      { type: "test-action", ref: "omnirush.computerUse.healthCheck", label: "Verify Computer Use MCP" },
      { type: "composer-prompt", prompt: "Use Computer Use to ", location: "composer" },
    ],
    enablement: [
      { type: "mcp-connected", ref: "computer-use", label: "MCP server connected" },
      { type: "permission-granted", ref: "accessibility", label: "Accessibility permission" },
      { type: "permission-granted", ref: "screenRecording", label: "Screen Recording permission" },
    ],
    lifecycle: { reload: ["mcp"], detection: ["mcp:computer-use"] },
    defaultEnabled: true,
    platform: ["darwin"],
  },
  {
    schemaVersion: 1,
    id: "ollama",
    name: "Ollama",
    description: "Local model provider at http://localhost:11434.",
    source: { format: "omnirush-builtin", origin: "builtin", trusted: true },
    icon: { src: "/ext-ollama.svg" },
    composer: { prompt: "Use the Ollama extension to " },
    setup: {
      instructions: "Run Ollama locally, choose or pull a model, then add it as an OpenCode provider.",
      primaryCta: "Add Ollama model",
      secondaryCta: "Pull model",
    },
    resources: [
      { type: "local-service", id: "ollama-api", label: "Ollama API", description: "http://localhost:11434", required: true },
      { type: "provider", id: "ollama", providerId: "ollama", packageName: "@ai-sdk/openai-compatible", required: true },
    ],
    contributions: [
      { type: "settings-panel", ref: "omnirush.ollama.settings", location: "settings-detail" },
      { type: "test-action", ref: "omnirush.ollama.listModels", label: "Check local models" },
      { type: "composer-prompt", prompt: "Use the Ollama extension to ", location: "composer" },
    ],
    enablement: [
      { type: "provider-connected", ref: "ollama", label: "Ollama provider" },
    ],
    lifecycle: { reload: ["config"], detection: ["provider:ollama"] },
  },
];
