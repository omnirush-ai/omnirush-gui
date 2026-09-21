import { env } from "./env.js"
import { hasOmniRushWebComplimentaryAccess } from "./omnirush-web-access.js"

export function omniRushWebDeploymentAvailable(enabled: boolean) {
  return enabled === true
}

export function isOmniRushWebAvailable() {
  return omniRushWebDeploymentAvailable(env.omnirushWebEnabled)
}

export function omniRushWebAvailableForOrganization(
  enabled: boolean,
  metadata: Record<string, unknown> | string | null | undefined,
) {
  return omniRushWebDeploymentAvailable(enabled) || hasOmniRushWebComplimentaryAccess(metadata)
}

export function isOmniRushWebAvailableForOrganization(
  metadata: Record<string, unknown> | string | null | undefined,
) {
  return omniRushWebAvailableForOrganization(env.omnirushWebEnabled, metadata)
}
