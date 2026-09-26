import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiError } from "./errors.js";
import { LocalWorkflowService, type LocalWorkflowPromptBody, type LocalWorkflowPromptDispatcher } from "./local-workflows.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

/**
 * A workflow step is a prompt dispatch: it must reach the engine only through
 * the injected dispatcher (the server's gated, collected engine proxy), never
 * through the SDK's prompt route. These tests drive the service with a fake
 * engine and a fake dispatcher; the real dispatcher is covered end to end in
 * workspace-collector.server.e2e.test.ts.
 */

type EngineFactory = ConstructorParameters<typeof LocalWorkflowService>[1];
type Engine = ReturnType<EngineFactory>;

const model = { providerID: "anthropic", modelID: "claude-sonnet-4-5" };
const previousDataDir = process.env.OMNIRUSH_DATA_DIR;
let dataDir = "";
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "omnirush-local-workflows-data-"));
  process.env.OMNIRUSH_DATA_DIR = dataDir;
});

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.OMNIRUSH_DATA_DIR;
  else process.env.OMNIRUSH_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnirush-local-workflows-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace: WorkspaceInfo = { id: "ws_wf", name: "Workflows", path: root, preset: "starter", workspaceType: "local", baseUrl: "http://127.0.0.1:9" };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "owt_test_token", hostToken: "owt_host_token", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [root],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "json", logRequests: false,
  };
  const engine = { creates: [] as unknown[], sdkPrompts: 0, aborts: [] as string[] };
  const engineFactory: EngineFactory = () => ({
    provider: {
      list: async () => ({ data: { all: [{ id: model.providerID, name: "Anthropic", models: { [model.modelID]: { name: "Sonnet" } } }], connected: [model.providerID], default: {} }, error: undefined }),
    },
    session: {
      create: async (body: unknown) => { engine.creates.push(body); return { data: { id: `ses_workflow_${engine.creates.length}` }, error: undefined }; },
      prompt: async () => { engine.sdkPrompts += 1; throw new Error("the SDK prompt route bypasses the gate and the collector"); },
      abort: async (input: { sessionID: string }) => { engine.aborts.push(input.sessionID); return { data: true, error: undefined }; },
    },
  }) as unknown as Engine;
  const dispatched: Array<{ sessionId: string; body: LocalWorkflowPromptBody; workspaceId: string }> = [];
  // What the fake dispatcher does: refuse at the gate, or answer the prompt.
  const control = {
    refuse: false,
    respond: (): Response => Response.json({ info: { id: "asst_1", role: "assistant" }, parts: [{ type: "text", text: "All good" }] }),
  };
  const dispatcher: LocalWorkflowPromptDispatcher = {
    assertAllowed(target) {
      if (control.refuse) throw new ApiError(403, "omnirush_account_required", "Sign in to omnirush.ai from Settings to start a session.");
      expect(target.id).toBe(workspace.id);
    },
    async prompt(target, sessionId, body, signal) {
      expect(signal.aborted).toBe(false);
      dispatched.push({ sessionId, body, workspaceId: target.id });
      return control.respond();
    },
  };
  const service = new LocalWorkflowService(config, engineFactory, dispatcher);
  cleanups.push(() => service.stop());
  await service.saveRouting(workspace, { enabled: true, defaultModel: model, categories: {} });
  const workflow = await service.upsert(workspace, {
    name: "Nightly summary", description: "", enabled: false, intervalMinutes: null,
    steps: [
      { id: "s1", name: "Summarise", prompt: "Summarise the repository", category: "auto", model: null },
      { id: "s2", name: "Review", prompt: "Review this: {{previous}}", category: "auto", model: null },
    ],
  });
  const settled = async (runId: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const run = await service.getRun(workspace, runId);
      if (run.status !== "running") return run;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the workflow run did not settle");
  };
  return { workspace, service, workflow, engine, dispatcher: control, dispatched, settled };
}

describe("local workflow prompt dispatch", () => {
  test("refuses a run when the sign-in gate applies, before any engine session or run record exists", async () => {
    const { workspace, service, workflow, engine, dispatcher, dispatched } = await fixture();
    dispatcher.refuse = true;
    for (const trigger of ["manual", "schedule"] as const) {
      if (trigger === "schedule") await service.upsert(workspace, { ...workflow, enabled: true, intervalMinutes: 5 }, workflow.id);
      const error = await service.run(workspace, workflow.id, trigger).then(() => null, (thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(ApiError);
      expect(error instanceof ApiError ? [error.status, error.code, error.message] : null).toEqual([
        403, "omnirush_account_required", "Sign in to omnirush.ai from Settings to start a session.",
      ]);
    }
    expect(engine.creates).toEqual([]);
    expect(dispatched).toEqual([]);
    expect((await service.snapshot(workspace)).runs).toEqual([]);
  });

  test("sends every step through the dispatcher, never through the SDK prompt route", async () => {
    const { workspace, service, workflow, engine, dispatched, settled } = await fixture();
    const started = await service.run(workspace, workflow.id);
    expect(started.status).toBe("running");
    const run = await settled(started.id);
    expect(run.status).toBe("completed");
    expect(run.steps.map((step) => [step.status, step.sessionId, step.output])).toEqual([
      ["completed", "ses_workflow_1", "All good"],
      ["completed", "ses_workflow_2", "All good"],
    ]);
    expect(engine.sdkPrompts).toBe(0);
    expect(engine.creates).toHaveLength(2);
    expect(dispatched).toEqual([
      { workspaceId: "ws_wf", sessionId: "ses_workflow_1", body: { model, parts: [{ type: "text", text: "Summarise the repository" }] } },
      { workspaceId: "ws_wf", sessionId: "ses_workflow_2", body: { model, parts: [{ type: "text", text: "Review this: All good" }] } },
    ]);
  });

  test("surfaces the proxy's refusal as the step failure and stops the run", async () => {
    const { workspace, service, workflow, engine, dispatcher, dispatched, settled } = await fixture();
    dispatcher.respond = () => Response.json({ error: "omnirush_account_required", message: "Sign in to omnirush.ai from Settings to start a session." }, { status: 403 });
    const run = await settled((await service.run(workspace, workflow.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("Sign in to omnirush.ai from Settings to start a session.");
    expect(run.steps.map((step) => step.status)).toEqual(["failed", "cancelled"]);
    expect(dispatched).toHaveLength(1);
    expect(engine.sdkPrompts).toBe(0);
    // The owned engine session is aborted when a step fails. The abort runs
    // right after the failed status is saved, so wait for it briefly.
    for (let waited = 0; engine.aborts.length === 0 && waited < 2_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.aborts).toEqual(["ses_workflow_1"]);
  });

  test("treats an engine error in the assistant message as the step failure", async () => {
    const { workspace, service, workflow, dispatcher, settled } = await fixture();
    dispatcher.respond = () => Response.json({ info: { id: "asst_1", role: "assistant", error: { name: "ProviderError", data: { message: "rate limited by sk-1234567890abcdefghijklmnop" } } }, parts: [] });
    const run = await settled((await service.run(workspace, workflow.id)).id);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("rate limited by [REDACTED]");
  });
});
