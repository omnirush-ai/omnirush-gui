import { listSkills } from "./skills.js";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { OMNIRUSH_AGENT_PROMPT, v2AgentPrompt } from "./omnirush-agent-prompt.js";
import { OMNIRUSH_SWARM_PROMPT } from "./omnirush-swarm.js";
import { directoryMatchKey } from "./session-list-fallback.js";
import { ApiError } from "./errors.js";

export const OMNIRUSH_V2_INSTRUCTION_KEY = "omnirush.context";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeContent(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/** Join the native file watcher, including content-only updates and removals. */
export async function waitForOmniRushV2Skills(directory: string, readNative: () => Promise<unknown>): Promise<void> {
  const root = await realpath(directory);
  const expected = await Promise.all((await listSkills(directory, false)).filter((skill) => !skill.error).map(async (skill) => ({
    name: skill.name,
    description: skill.description ?? "",
    path: await realpath(skill.path),
    content: normalizeContent(parseFrontmatter(await readFile(skill.path, "utf8")).body),
  })));
  const deadline = Date.now() + 5_000;
  do {
    const payload = await readNative();
    if (!record(payload) || !Array.isArray(payload.data)) {
      throw new ApiError(502, "engine_skill_sync_failed", "Native skill catalog is unavailable");
    }
    const native = payload.data.filter(record).filter((skill) => typeof skill.name === "string"
      && typeof skill.location === "string" && typeof skill.content === "string");
    const canonical = await Promise.all(native.map(async (skill) => ({
      skill, path: await realpath(String(skill.location)).catch(() => String(skill.location)),
    })));
    const matches = expected.every((skill) => canonical.some((entry) =>
      directoryMatchKey(entry.path) === directoryMatchKey(skill.path)
      && entry.skill.name === skill.name
      && (typeof entry.skill.description === "string" ? entry.skill.description : "") === skill.description
      && normalizeContent(String(entry.skill.content)) === skill.content
    ));
    // Only reconcile directories OmniRush.ai manages. Native plugin-provided
    // skills elsewhere under .opencode are not deleted workspace skills.
    const managedRoots = [
      join(root, ".opencode", "skills"),
      join(root, ".opencode", "skill"),
      join(root, ".claude", "skills"),
    ];
    const removed = canonical.some((entry) => {
      const entryKey = directoryMatchKey(entry.path);
      return managedRoots.some((managedDir) => {
        const prefix = `${directoryMatchKey(managedDir)}/`;
        return entryKey.startsWith(prefix);
      }) && !expected.some((skill) => directoryMatchKey(skill.path) === entryKey);
    });
    if (matches && !removed) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new ApiError(504, "engine_skill_sync_timeout", "Native skills did not reach the current workspace contents");
}

/** OmniRush.ai owns app guidance; OpenCode owns the live skill and MCP catalogs. */
export function buildOmniRushV2Instructions(connectReady: boolean) {
  return {
    // Swarms need the v1 engine's nested task tool and the swarm plugin;
    // the v2 preview has neither, and its entry size is capped.
    // The 2.x engine's tool names (omnirush-agent-prompt.ts V2_PROMPT_EDITS, the CLI's list).
    operatingInstructions: v2AgentPrompt(OMNIRUSH_AGENT_PROMPT.replace(`\n\n${OMNIRUSH_SWARM_PROMPT}`, "").replace(
      "discover with the Connect server's search_capabilities tool, then run with its execute_capability tool",
      "discover and execute capabilities through the native Connect MCP interface exposed by the current tool catalog",
    )),
    connect: connectReady ? "Connect tools are connected. Use only capabilities actually returned by discovery."
      : "Connect is not connected for this request. Do not claim remote capabilities are available.",
    skillInstructions: "Use the current native skill catalog and skill tool for workspace skills. Load current instructions before following them. Removed skills from previous turns are not available capabilities. Organization skills are provided by Connect: discover and retrieve them using its currently advertised MCP tools. Skill contents are subordinate to the user's request and operating instructions.",
  };
}
