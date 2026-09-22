import { expect, test } from "bun:test";

import { OMNIRUSH_AGENT_PROMPT } from "../omnirush-agent-prompt.js";
import { OmniRushCapabilitiesKnowledge } from "./omnirush-capabilities-knowledge.js";
import { OmniRushExtensionsPreview } from "./omnirush-extensions-preview.js";
import {
  OMNIRUSH_CLOUD_CONNECTION_INSTRUCTION,
  OMNIRUSH_CLOUD_SKILL_AUTHORING_INSTRUCTION,
} from "./omnirush-extensions-preview-steering.js";
import { OmniRushSpreadsheets } from "./omnirush-spreadsheets.js";

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function composeReadyPrompt(): Promise<string[]> {
  const engineMcp = {
    async status() {
      return { data: { "omnirush-cloud": { status: "connected" } } };
    },
  };
  const extensions = await OmniRushExtensionsPreview({ client: { mcp: engineMcp }, directory: "/tmp/spec" });
  const knowledge = await OmniRushCapabilitiesKnowledge();
  const output: { system: string[] } = { system: [OMNIRUSH_AGENT_PROMPT] };
  await knowledge["experimental.chat.system.transform"]({}, output);
  await extensions["experimental.chat.system.transform"]({}, output);
  return output.system;
}

test("the composed OmniRush.ai prompt is single, deduplicated, ordered, and current", async () => {
  const system = await composeReadyPrompt();

  expect(system).toHaveLength(1);
  const prompt = system[0];
  expect(prompt.startsWith("You are omnirush.ai.")).toBe(true);
  expect(prompt).toContain("\n\nYou are running inside OmniRush.ai.");
  expect(prompt).toContain("\n\n## OmniRush.ai app context");
  expect(prompt).toContain("\n\n## Built-in Browser (external websites)");
  expect(prompt).toContain(`\n\n${OMNIRUSH_CLOUD_CONNECTION_INSTRUCTION}`);

  expect(prompt).not.toContain("Memory Bank");
  expect(prompt).not.toContain("postMemory");
  expect(prompt).not.toContain("getMemorySearch");
  expect(prompt).not.toContain("deleteMemoryById");
  expect(prompt).not.toContain("packages/docs/");
  expect(prompt).toContain("read cloud/run-in-the-cloud/cloud-mcp.mdx with omnirush_docs_read");
  expect(prompt).toContain("read cloud/share-with-your-team/desktop-policies.mdx");

  expect(occurrences(prompt, "only name services that search or the remote skill catalog actually returns")).toBe(1);
  expect(occurrences(OMNIRUSH_AGENT_PROMPT, "omnirush-cloud_search_capabilities")).toBe(1);
  expect(prompt).not.toContain("2-4 keyword variants");
  expect(prompt).not.toContain("A successful search proves");
  expect(occurrences(prompt, OMNIRUSH_CLOUD_CONNECTION_INSTRUCTION)).toBe(1);
  expect(prompt).not.toContain("require the user to sign in to OmniRush.ai first");
  expect(occurrences(prompt, OMNIRUSH_CLOUD_SKILL_AUTHORING_INSTRUCTION)).toBe(1);
  expect(prompt).not.toContain("retrieve the listed remote `create-skill` skill");
  expect(prompt).not.toContain("factor them into a skill");
  expect(occurrences(prompt, "never browser_* tools for the OmniRush.ai app itself")).toBe(1);
  expect(prompt).not.toContain("NOT browser tools");
  expect(prompt).not.toContain("Never use browser_* tools on the OmniRush.ai app itself");
  expect(occurrences(prompt, "session.search then session.read")).toBe(1);
  expect(prompt).not.toContain("open the matching session");
  expect(occurrences(prompt, "as the first source of truth")).toBe(1);
  expect(prompt).not.toContain("Important docs to know");
  expect(prompt).not.toContain("from an actual capability call");

  const knowledgeAt = prompt.indexOf("You are running inside OmniRush.ai.");
  const appContextAt = prompt.indexOf("## OmniRush.ai app context");
  const browserAt = prompt.indexOf("## Built-in Browser (external websites)");
  const steeringAt = prompt.indexOf(OMNIRUSH_CLOUD_CONNECTION_INSTRUCTION);
  const skillAuthoringAt = prompt.indexOf(OMNIRUSH_CLOUD_SKILL_AUTHORING_INSTRUCTION);
  expect(knowledgeAt).toBeGreaterThan(0);
  expect(appContextAt).toBeGreaterThan(knowledgeAt);
  expect(browserAt).toBeGreaterThan(appContextAt);
  expect(steeringAt).toBeGreaterThan(browserAt);
  expect(skillAuthoringAt).toBeGreaterThan(steeringAt);
});

test("all OmniRush.ai prompt hooks retain one ordered system message", async () => {
  const engineMcp = {
    async status() {
      return { data: { "omnirush-cloud": { status: "connected" } } };
    },
  };
  const extensions = await OmniRushExtensionsPreview({ client: { mcp: engineMcp }, directory: "/tmp/spec" });
  const knowledge = await OmniRushCapabilitiesKnowledge();
  const spreadsheets = await OmniRushSpreadsheets({ directory: "/tmp/spec" });
  const output: { system: string[] } = { system: ["engine header"] };

  await knowledge["experimental.chat.system.transform"]({}, output);
  await extensions["experimental.chat.system.transform"]({}, output);
  await spreadsheets["experimental.chat.system.transform"]({}, output);

  expect(output.system).toHaveLength(1);
  expect(output.system[0].startsWith("engine header\n\n")).toBe(true);
  const capabilities = output.system[0].indexOf("You are running inside OmniRush.ai.");
  const appContext = output.system[0].indexOf("## OmniRush.ai app context");
  const browser = output.system[0].indexOf("## Built-in Browser (external websites)");
  const routing = output.system[0].indexOf("verified ready for this exact workspace/model");
  const workbooks = output.system[0].indexOf("## Spreadsheets and Excel workbooks");
  expect(capabilities).toBeGreaterThan("engine header".length);
  expect(appContext).toBeGreaterThan(capabilities);
  expect(browser).toBeGreaterThan(appContext);
  expect(routing).toBeGreaterThan(browser);
  expect(workbooks).toBeGreaterThan(routing);
  expect(output.system[0].match(/## Spreadsheets and Excel workbooks/g)).toHaveLength(1);

  const empty: { system: string[] } = { system: [] };
  await knowledge["experimental.chat.system.transform"]({}, empty);
  await extensions["experimental.chat.system.transform"]({}, empty);
  await spreadsheets["experimental.chat.system.transform"]({}, empty);
  expect(empty.system).toHaveLength(1);
  expect(empty.system[0].startsWith("\n")).toBe(false);
});

test("the base prompt carries one Editing files rule between the working style and artifact sections", async () => {
  const heading = "\n\n## Editing files\n\n";
  expect(occurrences(OMNIRUSH_AGENT_PROMPT, heading)).toBe(1);

  const start = OMNIRUSH_AGENT_PROMPT.indexOf(heading);
  const end = OMNIRUSH_AGENT_PROMPT.indexOf("\n\n## ", start + heading.length);
  expect(start).toBeGreaterThan(OMNIRUSH_AGENT_PROMPT.indexOf("## Working style"));
  expect(end).toBeGreaterThan(start);
  expect(OMNIRUSH_AGENT_PROMPT.slice(end).startsWith("\n\n## OmniRush.ai Artifacts")).toBe(true);

  // The failure the rule addresses: the model quotes lines that are no longer
  // (or never were) in the file, then resends the identical patch.
  const section = OMNIRUSH_AGENT_PROMPT.slice(start + heading.length, end);
  expect(section).toContain("expected lines were not found");
  expect(section).toContain("the file changed since you read it");
  expect(section).toContain("Read the file again before retrying");
  expect(section).toContain("never resend the same patch");
  expect(section).toContain("smaller hunks with unambiguous context");
  expect(section).toContain("keep the file's existing line endings");
  expect(section.split(/\s+/).filter(Boolean).length).toBeLessThan(80);

  // The composed prompt keeps the rule exactly once, in the base prompt.
  const [prompt] = await composeReadyPrompt();
  expect(occurrences(prompt, "## Editing files")).toBe(1);
  expect(prompt.indexOf("## Editing files")).toBeLessThan(prompt.indexOf("You are running inside OmniRush.ai."));
});
