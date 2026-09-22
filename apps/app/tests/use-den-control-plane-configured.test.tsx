import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { isDenControlPlaneConfigured, STORAGE_BASE_URL } from "../src/app/lib/den";
import { dispatchDenSettingsChanged, denSettingsChangedEvent } from "../src/app/lib/den-session-events";
import { useDenControlPlaneConfigured } from "../src/react-app/domains/cloud/use-den-control-plane-configured";

function Probe() {
  const configured = useDenControlPlaneConfigured();
  return <span data-testid="probe">{configured ? "configured" : "unconfigured"}</span>;
}

describe("useDenControlPlaneConfigured", () => {
  let registeredDom = false;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
    if (registeredDom) GlobalRegistrator.register({ url: "https://web.example.test/session" });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.clear();
    if (registeredDom) await GlobalRegistrator.unregister();
  });

  test("reports no control plane on a clean install and follows the settings-changed event", async () => {
    expect(isDenControlPlaneConfigured()).toBe(false);
    await act(async () => root.render(<Probe />));
    expect(container.textContent).toBe("unconfigured");

    // Setting a server URL (Join organization, Settings > Cloud, a connect
    // link) writes the base URL and announces the change on the window.
    window.localStorage.setItem(STORAGE_BASE_URL, "https://den.example.test");
    await act(async () => {
      dispatchDenSettingsChanged({
        settings: {
          baseUrl: "https://den.example.test",
          apiBaseUrl: "https://den.example.test/api/den",
          authToken: null,
          activeOrgId: null,
          activeOrgSlug: null,
          activeOrgName: null,
        },
      });
    });
    expect(container.textContent).toBe("configured");

    window.localStorage.removeItem(STORAGE_BASE_URL);
    await act(async () => {
      window.dispatchEvent(new Event(denSettingsChangedEvent));
    });
    expect(container.textContent).toBe("unconfigured");
  });
});
