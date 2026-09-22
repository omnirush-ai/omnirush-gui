import { describe, expect, test } from "bun:test";

import {
  accountServerLine,
  accountSignOutMessage,
} from "../src/react-app/domains/settings/pages/general-view";

describe("settings sign-out message", () => {
  test("says exactly what happened to the remote device session", () => {
    expect(accountSignOutMessage({ remoteRevoked: true, reason: "revoked" }, "omnirush.ai")).toBe(
      "Signed out on this device and revoked its device session on omnirush.ai.",
    );
    expect(accountSignOutMessage({ remoteRevoked: true, reason: "already_revoked" }, "omnirush.ai")).toBe(
      "Signed out on this device. omnirush.ai had already revoked this device session.",
    );
    expect(accountSignOutMessage({ remoteRevoked: false, reason: "unreachable" }, "omnirush.ai")).toBe(
      "Signed out on this device. omnirush.ai could not be reached, so the device session was not revoked there.",
    );
    expect(
      accountSignOutMessage({ remoteRevoked: false, reason: "endpoint_missing" }, "localhost:8090 (local API)"),
    ).toBe(
      "Signed out on this device. localhost:8090 (local API) has no remote sign-out endpoint, so the device session was not revoked there.",
    );
  });

  test("falls back to the boolean outcome for a desktop bridge without reasons", () => {
    expect(accountSignOutMessage({ remoteRevoked: true }, null)).toBe(
      "Signed out on this device and revoked its device session on the account server.",
    );
    expect(accountSignOutMessage({ remoteRevoked: false }, "")).toBe(
      "Signed out on this device. The device session on the account server could not be revoked.",
    );
  });
});

describe("settings account server line", () => {
  test("names the connected server and the default server while signed out", () => {
    expect(accountServerLine({ connected: true, gatewayHost: "omnirush.ai" })).toBe("Connected to omnirush.ai");
    expect(accountServerLine({ connected: false, gatewayHost: "localhost:8090 (local API)" })).toBe(
      "Account server: localhost:8090 (local API)",
    );
  });

  test("renders nothing when the bridge reports no server", () => {
    expect(accountServerLine({ connected: true, gatewayHost: null })).toBe(null);
    expect(accountServerLine({ connected: false })).toBe(null);
    expect(accountServerLine({ connected: false, gatewayHost: "  " })).toBe(null);
  });
});
