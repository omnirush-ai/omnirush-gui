import { expect, test } from "bun:test";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

import { modeSwitchNote as sharedNote } from "../../server/src/model-modes/model-modes.mjs";
import { chatModeNote, chatStarted, fixedModelNote, modeAllowsModel, modeFallbackModel, modeSwitchNote, newChatAllowsModel, useProjectModelModes } from "../src/react-app/domains/session/surface/model-modes";

// As GET /omnirush/subagent-model lists them: `modes` normalized by the server.
const MODELS = [
  { id: "gpt-6-astra", name: "GPT 6 Astra", family: "OpenAI", default: true, efforts: [], modes: ["native", "box"] as Array<"native" | "box"> },
  { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", family: "Kimi", default: false, efforts: [], modes: ["native"] as Array<"native" | "box"> },
  { id: "boxonly-x", name: "Box Only X", family: "Other", default: false, efforts: [], modes: ["box"] as Array<"native" | "box"> },
];
const ref = (modelID: string, providerID = "omnirush") => ({ providerID, modelID });

test("a project's mode decides which omnirush models it may use; others, unknown ones and an unknown mode pass", () => {
  expect(modeAllowsModel(MODELS, "box", ref("kimi-k3.1-pro"))).toBe(false);
  expect(modeAllowsModel(MODELS, "native", ref("kimi-k3.1-pro"))).toBe(true);
  expect(modeAllowsModel(MODELS, "native", ref("boxonly-x"))).toBe(false);
  expect(modeAllowsModel(MODELS, "box", ref("boxonly-x"))).toBe(true);
  expect(modeAllowsModel(MODELS, "box", ref("new-model"))).toBe(true);
  expect(modeAllowsModel(MODELS, "box", ref("kimi-k3.1-pro", "openai"))).toBe(true);
  expect(modeAllowsModel(MODELS, null, ref("kimi-k3.1-pro"))).toBe(true);
  // An older server without modes: everything passes.
  expect(modeAllowsModel([{ ...MODELS[1]!, modes: undefined }], "box", ref("kimi-k3.1-pro"))).toBe(true);
});

test("a refused model moves to the default the mode allows, with the CLI's note", () => {
  expect(modeFallbackModel(MODELS, "native", ref("boxonly-x"))).toEqual(ref("gpt-6-astra"));
  expect(modeFallbackModel(MODELS, "box", ref("gpt-6-astra"))).toEqual(ref("gpt-6-astra"));
  expect(modeFallbackModel([MODELS[1]!, MODELS[2]!].map((m) => ({ ...m, default: m.id === "boxonly-x" })), "native", ref("boxonly-x"))).toEqual(ref("kimi-k3.1-pro"));
  expect(modeSwitchNote(MODELS, "box", ref("kimi-k3.1-pro"), ref("gpt-6-astra"))).toBe(sharedNote("Kimi K3.1 Pro", "GPT 6 Astra", "box"));
});

test("a new chat in a sandbox project may start on a model that runs only on this computer (it runs here); never on a sandbox-only one outside it", () => {
  expect(newChatAllowsModel(MODELS, "box", ref("kimi-k3.1-pro"))).toBe(true);
  expect(newChatAllowsModel(MODELS, "native", ref("boxonly-x"))).toBe(false);
  expect(modeFallbackModel(MODELS, "box", ref("kimi-k3.1-pro"))).toEqual(ref("kimi-k3.1-pro"));
  expect(modeFallbackModel(MODELS, "native", ref("boxonly-x"))).toEqual(ref("gpt-6-astra"));
  expect(fixedModelNote(MODELS, ref("kimi-k3.1-pro"), ref("gpt-6-astra"))).toBe("This chat runs on Kimi K3.1 Pro. Start a new chat to use GPT 6 Astra.");
  expect(chatModeNote(MODELS, "native", ref("boxonly-x"))).toBe("This chat runs on Box Only X, which isn't available outside the sandbox. Start a new chat.");
});

test("a new Work chat never starts on the omnirush-claude provider: it moves to the default", () => {
  const claude = ref("claude-opus-4-7", "omnirush-claude");
  expect(newChatAllowsModel(MODELS, "box", claude)).toBe(true);
  expect(newChatAllowsModel(MODELS, "box", claude, true)).toBe(false);
  expect(newChatAllowsModel(MODELS, "box", ref("gpt-6-astra"), true)).toBe(true);
  expect(modeFallbackModel(MODELS, "box", claude, true)).toEqual(ref("gpt-6-astra"));
  // Before the catalog loads: the built-in default, never Claude; outside Work nothing changes.
  expect(modeFallbackModel(undefined, null, claude, true)).toEqual(ref("gpt-6-astra"));
  expect(modeFallbackModel(undefined, null, claude)).toEqual(claude);
});

test("a chat with a prompt in the engine's messages is started, marked here or not", () => {
  const store = new Map<string, string>();
  const host = globalThis as { window?: unknown };
  const before = host.window;
  host.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } };
  try {
    const cache = getReactQueryClient();
    expect(chatStarted("ses_old")).toBe(false);
    cache.setQueryData(["react-session-transcript", "ws", "ses_old"], [{ role: "user" }, { role: "assistant" }]);
    expect(chatStarted("ses_old")).toBe(true);
    cache.setQueryData(["react-session-snapshot", "ws", "ses_snap"], { messages: [{ info: { role: "user" } }] });
    expect(chatStarted("ses_snap")).toBe(true);
    cache.setQueryData(["react-session-transcript", "ws", "ses_empty"], []);
    expect(chatStarted("ses_empty")).toBe(false);
    store.set("omnirush.sessionModelFixed", JSON.stringify(["ses_marked"]));
    expect(chatStarted("ses_marked")).toBe(true);
  } finally {
    host.window = before;
  }
});

test("a Work chat started on Claude sends nothing and says why; Code chats keep Claude", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const claude = ref("claude-opus-4-7", "omnirush-claude");
  const seen: Array<{ allows: boolean; note: string }> = [];
  const Probe = (props: { work: boolean }) => {
    const rules = useProjectModelModes(null, null, null, props.work);
    seen.push({ allows: rules.allows(claude), note: rules.chatNote(claude) });
    return null;
  };
  for (const work of [true, false]) renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe, { work })));
  expect(seen[0]).toEqual({ allows: false, note: "Claude can't use your Work tools. Pick another model to start a new chat." });
  expect(seen[1]?.allows).toBe(true);
});
