import { omnirushPluginPath } from "./omnirush-extensions-plugin-path.js";
export function managedPolicyPluginPath(next = false): string {
  return omnirushPluginPath(next ? "managed-policy-next" : "managed-policy");
}
