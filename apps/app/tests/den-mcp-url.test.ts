import { describe, expect, test } from "bun:test";

import {
  getDenMcpUrl,
  isLegacyWebAppMcpUrl,
  parseDenMcpToken,
  resolveCloudMcpResourceUrl,
  resolveDenBaseUrls,
} from "../src/app/lib/den";

describe("resolveDenBaseUrls", () => {
  test("adds the API proxy path to an explicit API base URL", () => {
    const resolved = resolveDenBaseUrls({
      baseUrl: "https://app.omnirushlabs.com",
      apiBaseUrl: "https://app.omnirushlabs.com",
    });
    expect(resolved.apiBaseUrl).toBe("https://app.omnirushlabs.com");
  });

  test("keeps an explicit API origin independent from the web base URL", () => {
    const resolved = resolveDenBaseUrls({
      baseUrl: "https://app.omnirushlabs.com",
      apiBaseUrl: "https://api.example.com",
    });
    expect(resolved.baseUrl).toBe("https://app.omnirushlabs.com");
    expect(resolved.apiBaseUrl).toBe("https://api.example.com");
  });

  test("keeps an explicit loopback API URL when a base URL is present", () => {
    const resolved = resolveDenBaseUrls({
      baseUrl: "http://localhost:3000",
      apiBaseUrl: "http://127.0.0.1:8787",
    });
    expect(resolved.baseUrl).toBe("http://localhost:3000");
    expect(resolved.apiBaseUrl).toBe("http://127.0.0.1:8787");
  });

  test("keeps the same-origin API path for a self-hosted baseUrl when no apiBaseUrl is set", () => {
    const resolved = resolveDenBaseUrls({ baseUrl: "https://den.self-hosted.example.com" });
    expect(resolved.baseUrl).toBe("https://den.self-hosted.example.com");
    expect(resolved.apiBaseUrl).toBe("https://den.self-hosted.example.com/api/den");
  });

  test("uses an explicit api host directly when no apiBaseUrl is set", () => {
    const resolved = resolveDenBaseUrls({ baseUrl: "https://api.den.example" });
    expect(resolved.baseUrl).toBe("https://api.den.example");
    expect(resolved.apiBaseUrl).toBe("https://api.den.example");
  });

  test("derives the api subdomain for hosted omnirushlabs.com deployments", () => {
    const resolved = resolveDenBaseUrls({ baseUrl: "https://staging.omnirushlabs.com" });
    expect(resolved.baseUrl).toBe("https://staging.omnirushlabs.com");
    expect(resolved.apiBaseUrl).toBe("https://api.staging.omnirushlabs.com");
  });

  test("uses the nested hosted API origin for the hosted web default", () => {
    const resolved = resolveDenBaseUrls({ baseUrl: "https://app.omnirushlabs.com" });
    expect(resolved.baseUrl).toBe("https://app.omnirushlabs.com");
    expect(resolved.apiBaseUrl).toBe("https://api.app.omnirushlabs.com");
  });
});

describe("getDenMcpUrl", () => {
  test("never targets the bare web-app origin", () => {
    const url = getDenMcpUrl();
    expect(isLegacyWebAppMcpUrl(url)).toBe(false);
    expect(url.endsWith("/mcp")).toBe(true);
  });
});

describe("isLegacyWebAppMcpUrl", () => {
  test("flags the legacy bare web-app MCP URL", () => {
    expect(isLegacyWebAppMcpUrl("https://app.omnirushlabs.com/mcp")).toBe(true);
    expect(isLegacyWebAppMcpUrl("https://app.omnirush.software/mcp/")).toBe(true);
  });

  test("accepts valid MCP URLs", () => {
    expect(isLegacyWebAppMcpUrl("https://app.omnirushlabs.com/api/den/mcp")).toBe(false);
    expect(isLegacyWebAppMcpUrl("http://127.0.0.1:8787/mcp")).toBe(false);
  });

  test("ignores empty or malformed input", () => {
    expect(isLegacyWebAppMcpUrl(null)).toBe(false);
    expect(isLegacyWebAppMcpUrl("not a url")).toBe(false);
  });
});

describe("resolveCloudMcpResourceUrl", () => {
  test("heals hosted minted web-app resources to the direct API origin", () => {
    expect(resolveCloudMcpResourceUrl("https://app.omnirushlabs.com/mcp")).toBe(
      "https://api.app.omnirushlabs.com/mcp",
    );
    expect(resolveCloudMcpResourceUrl("https://app.omnirushlabs.com/api/den/mcp")).toBe(
      "https://api.app.omnirushlabs.com/mcp",
    );
  });

  test("heals non-hosted legacy web-app resources through the /api/den proxy", () => {
    expect(resolveCloudMcpResourceUrl("https://app.omnirush.software/mcp/")).toBe(
      "https://app.omnirush.software/api/den/mcp",
    );
  });

  test("keeps healthy resources verbatim", () => {
    expect(resolveCloudMcpResourceUrl("https://api.app.omnirushlabs.com/mcp")).toBe(
      "https://api.app.omnirushlabs.com/mcp",
    );
    expect(resolveCloudMcpResourceUrl("https://app.example.com/api/den/mcp")).toBe(
      "https://app.example.com/api/den/mcp",
    );
    expect(resolveCloudMcpResourceUrl("http://127.0.0.1:8787/mcp")).toBe(
      "http://127.0.0.1:8787/mcp",
    );
  });

  test("returns null for unusable resources so callers keep their fallback", () => {
    expect(resolveCloudMcpResourceUrl(null)).toBeNull();
    expect(resolveCloudMcpResourceUrl("")).toBeNull();
    expect(resolveCloudMcpResourceUrl("   ")).toBeNull();
    expect(resolveCloudMcpResourceUrl("not a url")).toBeNull();
    expect(resolveCloudMcpResourceUrl("ftp://app.omnirushlabs.com/mcp")).toBeNull();
  });
});

describe("parseDenMcpToken", () => {
  test("accepts an older Den response while leaving the private App host closed", () => {
    expect(parseDenMcpToken({
      token: "central-token",
      expiresAt: "2026-08-18T00:00:00.000Z",
      organizationId: "org_1",
      scopes: ["mcp:read", "mcp:write"],
      resource: "https://api.omnirush.test/mcp",
    })).toEqual({
      token: "central-token",
      expiresAt: "2026-08-18T00:00:00.000Z",
      organizationId: "org_1",
      scopes: ["mcp:read", "mcp:write"],
      resource: "https://api.omnirush.test/mcp",
    });
  });

  test("keeps the App-host token pair only when both fields are present", () => {
    const base = {
      token: "central-token",
      expiresAt: "2026-08-18T00:00:00.000Z",
      organizationId: "org_1",
      scopes: ["mcp:read", "mcp:write"],
      resource: "https://api.omnirush.test/mcp",
    };
    expect(parseDenMcpToken({ ...base, appHostToken: "private-token" })?.appHostToken).toBeUndefined();
    expect(parseDenMcpToken({
      ...base,
      appHostToken: "private-token",
      appHostExpiresAt: "2026-08-18T00:00:00.000Z",
    })?.appHostToken).toBe("private-token");
  });
});
