export const OMNIRUSH_DEPLOYMENT_ENV_VAR = "VITE_OMNIRUSH_DEPLOYMENT";

export type OmniRushDeployment = "desktop" | "web";

function normalizeDeployment(value: string | undefined): OmniRushDeployment {
  const normalized = value?.trim().toLowerCase();
  return normalized === "web" ? "web" : "desktop";
}

export function getOmniRushDeployment(): OmniRushDeployment {
  const envValue =
    typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_OMNIRUSH_DEPLOYMENT === "string"
      ? import.meta.env.VITE_OMNIRUSH_DEPLOYMENT
      : undefined;

  return normalizeDeployment(envValue);
}

export function isWebDeployment(): boolean {
  return getOmniRushDeployment() === "web";
}

export function isDesktopDeployment(): boolean {
  return getOmniRushDeployment() === "desktop";
}
