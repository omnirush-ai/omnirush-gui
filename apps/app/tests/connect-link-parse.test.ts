import { describe, expect, test } from "bun:test";
import { parseConnectDeepLink } from "../src/app/lib/omnirush-links";

const TOKEN = "eyJhbGciOiJFZERTQSJ9.eyJmYWtlIjoxfQ.c2ln";

describe("parseConnectDeepLink", () => {
  test("parses production and dev desktop connect links", () => {
    const rawUrl = `omnirush://connect?token=${TOKEN}`;
    expect(parseConnectDeepLink(rawUrl)).toEqual({ rawUrl, key: `signed:${TOKEN}` });
    expect(parseConnectDeepLink(`omnirush-dev://connect?token=${TOKEN}`)?.key).toBe(`signed:${TOKEN}`);
    expect(parseConnectDeepLink(`omnirush:///connect?token=${TOKEN}`)?.key).toBe(`signed:${TOKEN}`);
  });

  test("parses keyless exchange links without accepting ambiguous transports", () => {
    const code = "abcdefghijklmnopqrstuvwxyz123456";
    const apiBaseUrl = "https://den.example.com/api/den";
    const rawUrl = `omnirush://connect?code=${code}&apiBaseUrl=${encodeURIComponent(apiBaseUrl)}`;
    expect(parseConnectDeepLink(rawUrl)).toEqual({
      rawUrl,
      key: `exchange:${apiBaseUrl}:${code}`,
    });
    expect(parseConnectDeepLink(`${rawUrl}&token=${TOKEN}`)).toBeNull();
  });

  test("does not activate from web URLs or unrelated desktop routes", () => {
    expect(parseConnectDeepLink(`https://omnirush.example.com/connect?token=${TOKEN}`)).toBeNull();
    expect(parseConnectDeepLink(`omnirush://den-auth?grant=${TOKEN}`)).toBeNull();
    expect(parseConnectDeepLink("omnirush://connect")).toBeNull();
    expect(parseConnectDeepLink("not a url")).toBeNull();
  });
});
