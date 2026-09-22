import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveOpencodeModelsEnv, resolveOpencodeModelsUrl } from "./opencode-models-url.js";

function restoreProcessEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

async function writeFakeOpencodeBin(root: string): Promise<string> {
  const binPath = join(root, "fake-opencode.mjs");
  await writeFile(binPath, [
    "#!/usr/bin/env bun",
    "const portIndex = process.argv.indexOf(\"--port\");",
    "const port = portIndex >= 0 ? process.argv[portIndex + 1] : \"0\";",
    "const capturePath = process.env.OMNIRUSH_CAPTURE_MODELS_URL_FILE;",
    "if (capturePath) await Bun.write(capturePath, JSON.stringify({ url: process.env.OPENCODE_MODELS_URL ?? null, disableFetch: process.env.OPENCODE_DISABLE_MODELS_FETCH ?? null }));",
    "console.log(`opencode server listening on http://127.0.0.1:${port}`);",
    "process.on(\"SIGTERM\", () => process.exit(0));",
    "setInterval(() => undefined, 1_000);",
  ].join("\n"));
  await chmod(binPath, 0o755);
  return binPath;
}

describe("resolveOpencodeModelsUrl", () => {
  test("honors an explicit catalog URL", async () => {
    expect(await resolveOpencodeModelsUrl({
      env: {
        OMNIRUSH_DEV_MODE: "1",
        OPENCODE_MODELS_URL: " https://catalog.example.test/models ",
      },
    })).toBe("https://catalog.example.test/models");
  });

  test("has no catalog outside development", async () => {
    expect(await resolveOpencodeModelsUrl({ env: {} })).toBeUndefined();
  });

  test("uses the local catalog when the development server is available", async () => {
    expect(await resolveOpencodeModelsUrl({
      env: { OMNIRUSH_DEV_MODE: "1" },
      fetchModels: async () => new Response(null, { status: 200 }),
    })).toBe("http://localhost:8791/models");
  });

  test("has no catalog when the development server is unavailable", async () => {
    expect(await resolveOpencodeModelsUrl({
      env: { OMNIRUSH_DEV_MODE: "1" },
      fetchModels: async () => new Response(null, { status: 503 }),
    })).toBeUndefined();
  });
});

describe("resolveOpencodeModelsEnv", () => {
  test("passes a configured catalog to the engine", async () => {
    expect(await resolveOpencodeModelsEnv({
      env: { OPENCODE_MODELS_URL: "https://catalog.example.test/models" },
    })).toEqual({ OPENCODE_MODELS_URL: "https://catalog.example.test/models" });
  });

  test("turns catalog fetches off when there is no catalog", async () => {
    expect(await resolveOpencodeModelsEnv({ env: {} })).toEqual({ OPENCODE_DISABLE_MODELS_FETCH: "1" });
    expect(await resolveOpencodeModelsEnv({
      env: { OMNIRUSH_DEV_MODE: "1" },
      fetchModels: async () => { throw new Error("connection refused"); },
    })).toEqual({ OPENCODE_DISABLE_MODELS_FETCH: "1" });
  });
});

/** Starts the embedded server with a fake engine and returns the catalog env the engine saw. */
async function captureEngineModelsEnv(env: { devMode?: string; modelsUrl?: string }): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "omnirush-embedded-models-url-"));
  const workspace = join(root, "workspace");
  const capturePath = join(root, "models-env.json");
  await mkdir(workspace, { recursive: true });
  const opencodeBin = await writeFakeOpencodeBin(root);

  const previousDevMode = process.env.OMNIRUSH_DEV_MODE;
  const previousModelsUrl = process.env.OPENCODE_MODELS_URL;
  const previousDisableFetch = process.env.OPENCODE_DISABLE_MODELS_FETCH;
  const previousCapturePath = process.env.OMNIRUSH_CAPTURE_MODELS_URL_FILE;
  const previousHome = process.env.HOME;
  const previousOpencodeBaseUrl = process.env.OMNIRUSH_OPENCODE_BASE_URL;

  try {
    restoreProcessEnv("OMNIRUSH_DEV_MODE", env.devMode);
    restoreProcessEnv("OPENCODE_MODELS_URL", env.modelsUrl);
    delete process.env.OPENCODE_DISABLE_MODELS_FETCH;
    process.env.OMNIRUSH_CAPTURE_MODELS_URL_FILE = capturePath;
    process.env.HOME = join(root, "home");
    delete process.env.OMNIRUSH_OPENCODE_BASE_URL;

    const { startEmbeddedServer } = await import("./embedded.js");
    const handle = await startEmbeddedServer({
      configPath: join(root, "server.json"),
      host: "127.0.0.1",
      port: 0,
      token: "server-token",
      hostToken: "host-token",
      workspaces: [workspace],
      manageOpencode: true,
      opencodeBin,
      opencodeCwd: workspace,
    });
    await handle.stop();

    return JSON.parse(await readFile(capturePath, "utf8"));
  } finally {
    restoreProcessEnv("OMNIRUSH_DEV_MODE", previousDevMode);
    restoreProcessEnv("OPENCODE_MODELS_URL", previousModelsUrl);
    restoreProcessEnv("OPENCODE_DISABLE_MODELS_FETCH", previousDisableFetch);
    restoreProcessEnv("OMNIRUSH_CAPTURE_MODELS_URL_FILE", previousCapturePath);
    restoreProcessEnv("HOME", previousHome);
    restoreProcessEnv("OMNIRUSH_OPENCODE_BASE_URL", previousOpencodeBaseUrl);
    await rm(root, { recursive: true, force: true });
  }
}

describe("startEmbeddedServer managed OpenCode models URL", () => {
  test("injects an explicit OPENCODE_MODELS_URL override", async () => {
    expect(await captureEngineModelsEnv({
      devMode: "1",
      modelsUrl: "https://catalog.example.test/models",
    })).toEqual({ url: "https://catalog.example.test/models", disableFetch: null });
  });

  test("gives the engine no catalog URL and turns catalog fetches off by default", async () => {
    expect(await captureEngineModelsEnv({})).toEqual({ url: null, disableFetch: "1" });
  });
});
