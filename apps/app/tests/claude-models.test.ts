import { describe, expect, test } from "bun:test";

import {
  claudeSandboxStep,
  decideModelPick,
  isClaudeModel,
  newChatPrompt,
  parseClaudeStatus,
  setUpClaudeSandbox,
  type ClaudeModelsState,
} from "../src/react-app/domains/session/surface/claude-models";
import { switchableModel } from "../src/react-app/domains/session/surface/model-modes";
import { switchableModels as sharedSwitchable } from "../../server/src/model-modes/strict-sessions.mjs";
import { builtinOmniRushModelCatalog } from "../../server/src/omnirush-model-catalog";

const opus = { providerID: "omnirush-claude", modelID: "claude-opus-5-5" };
const sonnet = { providerID: "omnirush-claude", modelID: "claude-sonnet-5-5" };
const astra = { providerID: "omnirush", modelID: "gpt-6-astra" };
const sol = { providerID: "omnirush", modelID: "gpt-6.1-sol" };
const catalog = [{ id: opus.modelID, name: "Claude Opus 5.5" }, { id: sonnet.modelID, name: "Claude Sonnet 5.5" }];
const allowed: ClaudeModelsState = { workspaceId: "w", catalog, models: [opus.modelID, sonnet.modelID], reason: null };
const denied: ClaudeModelsState = { workspaceId: "w", catalog, models: [], reason: "not_allowed" };

describe("Claude models", () => {
  test("only the engine's Claude provider's models are Claude models", () => {
    expect(isClaudeModel(opus)).toBe(true);
    expect(isClaudeModel(astra)).toBe(false);
    expect(isClaudeModel({ providerID: "omnirush", modelID: "claude-opus-5-5" })).toBe(false);
    expect(isClaudeModel({ providerID: "anthropic", modelID: "claude-opus-5-5" })).toBe(false);
  });

  test("the status answer is read defensively", () => {
    expect(parseClaudeStatus("w", { models: [opus.modelID, 7, "gpt-6-astra"], catalog: [...catalog, { id: "bad id" }, null], reason: null }))
      .toEqual({ workspaceId: "w", catalog, models: [opus.modelID], reason: null });
    expect(parseClaudeStatus("w", null)).toEqual({ workspaceId: "w", catalog: [], models: [], reason: null });
  });
});

describe("popup decision", () => {
  test("a fresh chat just switches (Claude once its sandbox is set up)", () => {
    expect(decideModelPick({ next: sol, current: astra, started: false, claude: allowed })).toEqual({ kind: "switch" });
    expect(decideModelPick({ next: sonnet, current: astra, started: false, claude: allowed })).toEqual({ kind: "claude" });
    expect(decideModelPick({ next: opus, current: null, started: false, claude: allowed })).toEqual({ kind: "claude" });
  });

  test("a started chat on another model offers a new chat, Claude or not", () => {
    expect(decideModelPick({ next: sol, current: astra, started: true, claude: allowed })).toEqual({ kind: "new_chat" });
    expect(decideModelPick({ next: sonnet, current: astra, started: true, claude: allowed })).toEqual({ kind: "new_chat" });
    expect(decideModelPick({ next: astra, current: astra, started: true, claude: allowed })).toEqual({ kind: "same" });
  });

  test("a started chat switches within its provider without the popup; another provider or no group offers a new chat", () => {
    const models = [
      { id: "gpt-6-astra", name: "GPT 6 Astra", family: "OpenAI", default: true, efforts: [], switch_group: "openai" },
      { id: "gpt-6.1-sol", name: "GPT 6.1 Sol", family: "OpenAI", default: false, efforts: [], switch_group: "openai" },
      { id: "gpt-6-sol", name: "GPT 6 Sol", family: "OpenAI", default: false, efforts: [], switch_group: "openai" },
      { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", family: "Kimi", default: false, efforts: [], switch_group: "kimi" },
      { id: "gpt-old", name: "Old", family: "OpenAI", default: false, efforts: [] },
    ];
    const switchable = (current: typeof astra, next: typeof astra) => switchableModel(models, current, next);
    const sol6 = { providerID: "omnirush", modelID: "gpt-6-sol" };
    for (const [current, next] of [[astra, sol], [sol, sol6], [sol6, astra]]) {
      expect(decideModelPick({ next, current, started: true, claude: allowed, switchable })).toEqual({ kind: "switch" });
    }
    for (const next of [{ providerID: "omnirush", modelID: "kimi-k3.1-pro" }, { providerID: "omnirush", modelID: "gpt-old" }, sonnet, { providerID: "openai", modelID: "gpt-6.1-sol" }]) {
      expect(decideModelPick({ next, current: astra, started: true, claude: allowed, switchable })).toEqual({ kind: "new_chat" });
    }
    // The same rule as the shared module's (apps/server/src/model-modes/strict-sessions.mjs).
    for (const a of models) for (const b of models) {
      expect(switchableModel(models, { providerID: "omnirush", modelID: a.id }, { providerID: "omnirush", modelID: b.id }) || a.id === b.id).toBe(sharedSwitchable(models, a.id, b.id));
    }
    // No group known (an older server): a new chat.
    expect(decideModelPick({ next: sol, current: astra, started: true, claude: allowed, switchable: (c, n) => switchableModel(undefined, c, n) })).toEqual({ kind: "new_chat" });
  });

  test("a fresh install (only the built-in model list, before the first sync) switches Astra to Sol without the popup", () => {
    // As GET /omnirush/subagent-model serves the built-ins (apps/server/src/server.ts).
    const models = builtinOmniRushModelCatalog().map((model) => ({ id: model.id, name: model.display_name, family: model.family, default: model.default, efforts: model.reasoning_levels, ...(model.switch_group ? { switch_group: model.switch_group } : {}) }));
    const switchable = (current: typeof astra, next: typeof astra) => switchableModel(models, current, next);
    expect(decideModelPick({ next: sol, current: astra, started: true, claude: allowed, switchable })).toEqual({ kind: "switch" });
  });

  test("an account without Claude is told plainly, wherever it picks, with no switch", () => {
    for (const started of [false, true]) {
      expect(decideModelPick({ next: sonnet, current: astra, started, claude: denied }))
        .toEqual({ kind: "unavailable", message: "Claude Sonnet 5.5 isn't available on your account yet." });
    }
    expect(decideModelPick({ next: opus, current: null, started: false, claude: { ...denied, reason: "client_outdated" } }))
      .toEqual({ kind: "unavailable", message: "Claude Opus 5.5 needs the latest OmniRush. Update the app to use it." });
    // A model the account may run alongside one it may not.
    expect(decideModelPick({ next: sonnet, current: null, started: false, claude: { ...allowed, models: [opus.modelID] } }).kind).toBe("unavailable");
  });

  test("the popup names both models", () => {
    expect(newChatPrompt("GPT 6 Astra", "Claude Sonnet 5.5").title).toBe("Start a new chat with Claude Sonnet 5.5?");
  });
});

describe("auto sandbox", () => {
  const box = (on: boolean, need: string = "none", declined = false) => ({ on, setup: { need, declined } }) as never;

  test("the next step: on, then this computer's setup, then nothing", () => {
    expect(claudeSandboxStep(null)).toBeNull();
    expect(claudeSandboxStep(box(false))).toBe("on");
    expect(claudeSandboxStep(box(true, "linux_allow"))).toBe("linux_allow");
    expect(claudeSandboxStep(box(true, "win_install"))).toBe("win_install");
    expect(claudeSandboxStep(box(true, "win_install", true))).toBeNull();
    expect(claudeSandboxStep(box(true, "mac_vm"))).toBeNull();
    expect(claudeSandboxStep(box(true, "cannot_run"))).toBeNull();
    expect(claudeSandboxStep(box(true))).toBeNull();
  });

  test("a native project is turned on and set up once, with no loop", async () => {
    const calls: string[] = [];
    const client = {
      getWorkspaceBox: async () => { calls.push("get"); return box(false); },
      setWorkspaceBox: async (_: string, mode: string | null) => { calls.push(`set:${mode}`); return box(true, "linux_allow"); },
      // The step did not take (the person closed the prompt): never asked again in a loop.
      setupWorkspaceBox: async (_: string, action: string) => { calls.push(`setup:${action}`); return box(true, "linux_allow"); },
    };
    const result = await setUpClaudeSandbox(client as never, "w");
    expect(calls).toEqual(["get", "set:on", "setup:linux_allow"]);
    expect((result as { on: boolean }).on).toBe(true);
  });

  test("a sandbox project already set up is left alone", async () => {
    const calls: string[] = [];
    const client = {
      getWorkspaceBox: async () => { calls.push("get"); return box(true); },
      setWorkspaceBox: async () => { throw new Error("must not change"); },
      setupWorkspaceBox: async () => { throw new Error("must not change"); },
    };
    await setUpClaudeSandbox(client as never, "w");
    expect(calls).toEqual(["get"]);
  });
});
