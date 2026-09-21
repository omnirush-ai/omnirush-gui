// Gateway runtime detection primitives. Leaf module by design: keep it import-free
// so low-level clients can choose same-origin gateway behavior without cycles.
export type OmniRushGatewayMarker = {
  version?: number;
  build?: string;
};

declare global {
  interface Window {
    __OMNIRUSH_GATEWAY__?: OmniRushGatewayMarker;
  }
}

const DEN_AUTH_TOKEN_STORAGE_KEY = "omnirush.den.authToken";

export function isOmniRushGatewayRuntime() {
  return typeof window !== "undefined" && window.__OMNIRUSH_GATEWAY__?.version === 1;
}

export function getOmniRushGatewayBuild(): string | null {
  if (!isOmniRushGatewayRuntime()) return null;
  const build = window.__OMNIRUSH_GATEWAY__?.build?.trim() ?? "";
  return build || null;
}

export function getOmniRushGatewayOrigin() {
  if (!isOmniRushGatewayRuntime()) return null;
  const origin = window.location.origin.trim();
  return origin || null;
}

export function readOmniRushGatewayDenToken() {
  if (!isOmniRushGatewayRuntime()) return "";
  try {
    return window.localStorage.getItem(DEN_AUTH_TOKEN_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}
