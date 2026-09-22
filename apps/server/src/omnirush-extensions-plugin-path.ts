import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare global {
  namespace NodeJS {
    interface Process {
      resourcesPath?: string;
    }
  }
}

function resourcesPathFromAppAsarPath(path: string): string | null {
  const match = /[\\/]app\.asar(?:[\\/]|$)/.exec(path);
  return match ? path.slice(0, match.index) : null;
}

export function omnirushPluginPath(name: string, here?: string): string {
  const pluginDir = process.env.OMNIRUSH_EXTENSIONS_PLUGIN_DIR;
  if (pluginDir) {
    return join(pluginDir, `${name}.js`);
  }

  here = here ?? dirname(fileURLToPath(import.meta.url));
  const resourcesPath = resourcesPathFromAppAsarPath(here);
  if (resourcesPath) {
    const electronResourcesPath = process.resourcesPath?.includes("app.asar") ? resourcesPath : process.resourcesPath?.trim();
    return join(electronResourcesPath || resourcesPath, "opencode-plugins", `${name}.js`);
  }

  const extension = basename(here) === "dist" ? "js" : "ts";
  return join(here, "opencode-plugins", `${name}.${extension}`);
}

export const omnirushExtensionsPreviewPluginPath = () => omnirushPluginPath("omnirush-extensions-preview");
export const omnirushChromeDevtoolsPluginPath = () => omnirushPluginPath("omnirush-chrome-devtools");
export const omnirushCapabilitiesKnowledgePluginPath = () => omnirushPluginPath("omnirush-capabilities-knowledge");
export const omnirushAnthropicAdaptiveThinkingPluginPath = () => omnirushPluginPath("omnirush-anthropic-adaptive-thinking");
export const omnirushAnthropicToolSchemaPluginPath = () => omnirushPluginPath("omnirush-anthropic-tool-schema");
export const omnirushOfficeAttachmentsPluginPath = () => omnirushPluginPath("omnirush-office-attachments");
export const omnirushSpreadsheetsPluginPath = () => omnirushPluginPath("omnirush-spreadsheets");
export const omnirushPdfAttachmentsPluginPath = () => omnirushPluginPath("omnirush-pdf-attachments");
export const omnirushTitleRecoveryPluginPath = () => omnirushPluginPath("omnirush-title-recovery");
export const omnirushReasoningEffortPluginPath = () => omnirushPluginPath("omnirush-reasoning-effort");
