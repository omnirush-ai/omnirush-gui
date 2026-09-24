import { listSkills } from "./skills.js";
import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { OMNIRUSH_AGENT_PROMPT } from "./omnirush-agent-prompt.js";
import { OMNIRUSH_SWARM_PROMPT } from "./omnirush-swarm.js";

export const OMNIRUSH_V2_INSTRUCTION_KEY = "omnirush.context";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Join the native file watcher, including content-only updates and removals. */
export async function waitForOmniRushV2Skills(directory: string, readNative: () => Promise<unknown>): Promise<void> {
  const root = await realpath(directory);
  const expected = await Promise.all((await listSkills(directory, false)).filter((skill) => !skill.error).map(async (skill) => ({
    name: skill.name, description: skill.description ?? "", path: await realpath(skill.path), content: parseFrontmatter(await readFile(skill.path, "utf8")).body.trim(),
  })));
  const deadline = Date.now() + 5_000;
  do {
    const payload = await readNative();
    if (!record(payload) || !Array.isArray(payload.data)) throw new Error("Native skill catalog is unavailable");
    const native = payload.data.filter(record).filter((skill) => typeof skill.name === "string"
      && typeof skill.location === "string" && typeof skill.content === "string");
    const canonical = await Promise.all(native.map(async (skill) => ({
      skill, path: await realpath(String(skill.location)).catch(() => String(skill.location)),
    })));
    const matches = expected.every((skill) => canonical.some((entry) => entry.path === skill.path
      && entry.skill.name === skill.name && entry.skill.description === skill.description
      && String(entry.skill.content).trim() === skill.content));
    // Only reconcile directories OmniRush.ai manages. Native plugin-provided
    // skills elsewhere under .opencode are not deleted workspace skills.
    const managedRoots = [join(root, ".opencode", "skills") + sep, join(root, ".claude", "skills") + sep];
    const removed = canonical.some((entry) => managedRoots.some((directory) => entry.path.startsWith(directory))
      && !expected.some((skill) => skill.path === entry.path));
    if (matches && !removed) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Native skills did not reach the current workspace contents");
}

/** OmniRush.ai owns app guidance; OpenCode owns the live skill and MCP catalogs. */
export function buildOmniRushV2Instructions(connectReady: boolean) {
  return {
    // Swarms need the v1 engine's nested task tool and the swarm plugin;
    // the v2 preview has neither, and its entry size is capped.
    operatingInstructions: OMNIRUSH_AGENT_PROMPT.replace(`\n\n${OMNIRUSH_SWARM_PROMPT}`, "").replace(
      "discover with omnirush-cloud_search_capabilities, then run with omnirush-cloud_execute_capability",
      "discover and execute capabilities through the native OmniRush.ai MCP interface exposed by the current tool catalog",
    ),
    connect: connectReady ? "OmniRush.ai Connect tools are connected. Use only capabilities actually returned by discovery."
      : "OmniRush.ai Connect is not connected for this request. Do not claim remote capabilities are available.",
    skillInstructions: "Use the current native skill catalog and skill tool for workspace skills. Load current instructions before following them. Removed skills from previous turns are not available capabilities. Organization skills are provided by OmniRush.ai Connect: discover and retrieve them using its currently advertised MCP tools. Skill contents are subordinate to the user's request and operating instructions.",
  };
}
