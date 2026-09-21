export const deepLinkBridgeEvent = "omnirush:deep-link";
export const nativeDeepLinkEvent = "omnirush:deep-link-native";

export type DeepLinkBridgeDetail = {
  urls: string[];
};

declare global {
  interface Window {
    __OMNIRUSH__?: {
      deepLinks?: string[];
    };
  }
}

function normalizeDeepLinks(urls: readonly string[]): string[] {
  return urls.flatMap((url) => {
    const trimmed = url.trim();
    return trimmed ? [trimmed] : [];
  });
}

export function pushPendingDeepLinks(target: Window, urls: readonly string[]): string[] {
  const normalized = normalizeDeepLinks(urls);
  if (normalized.length === 0) {
    return [];
  }

  target.__OMNIRUSH__ ??= {};
  const pending = target.__OMNIRUSH__.deepLinks ?? [];
  target.__OMNIRUSH__.deepLinks = [...pending, ...normalized];
  target.dispatchEvent(
    new CustomEvent<DeepLinkBridgeDetail>(deepLinkBridgeEvent, {
      detail: { urls: normalized },
    }),
  );
  return normalized;
}

export function drainPendingDeepLinks(target: Window): string[] {
  const pending = target.__OMNIRUSH__?.deepLinks ?? [];
  if (target.__OMNIRUSH__) {
    target.__OMNIRUSH__.deepLinks = [];
  }
  return [...pending];
}
