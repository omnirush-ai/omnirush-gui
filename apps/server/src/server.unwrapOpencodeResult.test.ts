import { describe, expect, test } from "bun:test";

import { ApiError } from "./errors.js";
import { unwrapOpencodeResult } from "./server.js";

function captureFailure(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

describe("unwrapOpencodeResult", () => {
  test("maps an error without a response to opencode_unreachable", () => {
    const error = { message: "fetch failed" };
    const failure = captureFailure(() => unwrapOpencodeResult({ data: undefined, error }, "/session"));

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 502,
      code: "opencode_unreachable",
      details: { body: error, path: "/session" },
    });
  });

  test("maps an error with a response to opencode_request_failed", () => {
    const error = { message: "bad gateway" };
    const failure = captureFailure(() => unwrapOpencodeResult({
      data: undefined,
      error,
      response: new Response(null, { status: 503 }),
    }, "/session"));

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 502,
      code: "opencode_request_failed",
      details: { status: 503, body: error, path: "/session" },
    });
  });

  test("maps the engine's ConfigInvalidError body to opencode_config_invalid with the engine's own message", () => {
    // 1.18.32 answers every instance-scoped route this way when a workspace
    // opencode.json(c) carries a V2 `permissions` key.
    const message = 'V2 permissions are not supported by OpenCode V1. Use V1 "permission" rules or run opencode2.';
    const error = {
      name: "ConfigInvalidError",
      data: { path: "/ws/.opencode/opencode.json", issues: [{ path: ["permissions"], message }] },
    };
    const failure = captureFailure(() => unwrapOpencodeResult({
      data: undefined,
      error,
      response: new Response(null, { status: 400 }),
    }, "/session"));

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 422,
      code: "opencode_config_invalid",
      message: `OpenCode configuration is invalid at /ws/.opencode/opencode.json: ${message} (permissions)`,
      details: {
        status: 400,
        name: "ConfigInvalidError",
        file: "/ws/.opencode/opencode.json",
        issues: [{ path: ["permissions"], message }],
        path: "/session",
      },
    });
  });

  test("keeps the generic mapping for non-config engine errors", () => {
    const error = { name: "UnknownError", data: { message: "Unexpected server error.", ref: "err_1" } };
    const failure = captureFailure(() => unwrapOpencodeResult({
      data: undefined,
      error,
      response: new Response(null, { status: 500 }),
    }, "/session"));

    expect(failure).toMatchObject({ status: 502, code: "opencode_request_failed", details: { status: 500, body: error } });
  });

  test("returns data unchanged", () => {
    const data = { id: "session-1" };
    expect(unwrapOpencodeResult({ data, error: undefined, response: new Response() }, "/session")).toBe(data);
  });

  test("maps a result with neither data nor error to opencode_empty_response", () => {
    const failure = captureFailure(() => unwrapOpencodeResult({
      data: undefined,
      error: undefined,
      response: new Response(),
    }, "/session"));

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 502, code: "opencode_empty_response" });
  });
});
