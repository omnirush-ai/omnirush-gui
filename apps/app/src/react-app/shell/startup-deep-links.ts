import {
  pushPendingDeepLinks,
} from "../../app/lib/deep-link-bridge";
import { subscribeDesktopDeepLinks } from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";
import { useWorkInviteStore, workInviteToken } from "../domains/work/work-mode";

let started = false;

// Work invite links are kept here: the other link handlers drain the queue before the shell mounts.
function push(urls: readonly string[]): void {
  for (const url of urls) {
    const token = workInviteToken(url);
    if (token) useWorkInviteStore.getState().setToken(token);
  }
  pushPendingDeepLinks(window, urls);
}

export function startDeepLinkBridge(): void {
  if (typeof window === "undefined" || started) return;
  started = true;

  if (!isDesktopRuntime()) {
    push([window.location.href]);
    return;
  }

  void (async () => {
    try {
      await subscribeDesktopDeepLinks((urls) => {
        push(urls);
      });
    } catch {
      // ignore startup failures
    }
  })();
}
