import { join } from "node:path";
import { resolveWorkspaceOpencodeConfigPath } from "@omnirush/paths";

export function opencodeConfigPath(workspaceRoot: string): string {
  return resolveWorkspaceOpencodeConfigPath(workspaceRoot);
}

export function omnirushConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "omnirush.json");
}

export function projectSkillsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "skills");
}

export function projectCommandsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "commands");
}

export function projectPluginsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "plugins");
}
