import { isOmniRushGatewayRuntime } from "./gateway-runtime";

export function canCreateWorkspaces() {
  return !isOmniRushGatewayRuntime();
}
