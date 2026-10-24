import { expect, test } from "bun:test";

import { modeSwitchNote as sharedNote } from "../../server/src/model-modes/model-modes.mjs";
import { chatModeNote, fixedModelNote, modeAllowsModel, modeFallbackModel, modeSwitchNote, newChatAllowsModel } from "../src/react-app/domains/session/surface/model-modes";

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
