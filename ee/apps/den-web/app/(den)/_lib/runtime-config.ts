import { setDenApiOriginOverride } from "./den-api-origin";

export type DenOrgMode = "single_org" | "multi_org";

export type DenWebRuntimeConfig = {
  denApiUrl: string;
  omnirushAppConnectUrl: string;
  omnirushWebUrl: string;
  omnirushAuthCallbackUrl: string;
  orgMode: DenOrgMode;
  singleOrgName: string;
  singleOrgSlug: string;
  singleOrgAllowPublicSignup: boolean;
  singleOrgSsoConfigured: boolean;
};

export const DEFAULT_OMNIRUSH_WEB_URL = "https://web.omnirushlabs.com";

export const EMPTY_RUNTIME_CONFIG: DenWebRuntimeConfig = {
  denApiUrl: "",
  omnirushAppConnectUrl: "",
  omnirushWebUrl: DEFAULT_OMNIRUSH_WEB_URL,
  omnirushAuthCallbackUrl: "",
  orgMode: "single_org",
  singleOrgName: "OmniRush.ai",
  singleOrgSlug: "default",
  singleOrgAllowPublicSignup: false,
  singleOrgSsoConfigured: false
};

let runtimeConfigPromise: Promise<DenWebRuntimeConfig> | null = null;

function normalizeOrgMode(value: unknown): DenOrgMode {
  return value === "multi_org" ? "multi_org" : "single_org";
}

function readStringProperty(value: object, key: string) {
  const property = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof property === "string" ? property.trim() : "";
}

function readBooleanProperty(value: object, key: string) {
  return Object.getOwnPropertyDescriptor(value, key)?.value === true;
}

function normalizeRuntimeConfig(value: unknown): DenWebRuntimeConfig {
  if (typeof value !== "object" || value === null) {
    return EMPTY_RUNTIME_CONFIG;
  }

  const singleOrgName = readStringProperty(value, "singleOrgName");
  const singleOrgSlug = readStringProperty(value, "singleOrgSlug");
  return {
    denApiUrl: readStringProperty(value, "denApiUrl"),
    omnirushAppConnectUrl: readStringProperty(value, "omnirushAppConnectUrl"),
    omnirushWebUrl: readStringProperty(value, "omnirushWebUrl") || DEFAULT_OMNIRUSH_WEB_URL,
    omnirushAuthCallbackUrl: readStringProperty(value, "omnirushAuthCallbackUrl"),
    orgMode: normalizeOrgMode(readStringProperty(value, "orgMode")),
    singleOrgName: singleOrgName || "OmniRush.ai",
    singleOrgSlug: singleOrgSlug || "default",
    singleOrgAllowPublicSignup: readBooleanProperty(value, "singleOrgAllowPublicSignup"),
    singleOrgSsoConfigured: readBooleanProperty(value, "singleOrgSsoConfigured")
  };
}

export function getRuntimeConfig(): Promise<DenWebRuntimeConfig> {
  if (!runtimeConfigPromise) {
    runtimeConfigPromise = fetch("/api/runtime-config", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          runtimeConfigPromise = null;
          return EMPTY_RUNTIME_CONFIG;
        }

        const config = normalizeRuntimeConfig(await response.json());
        setDenApiOriginOverride(config.denApiUrl);
        return config;
      })
      .catch(() => {
        runtimeConfigPromise = null;
        return EMPTY_RUNTIME_CONFIG;
      });
  }

  return runtimeConfigPromise;
}
