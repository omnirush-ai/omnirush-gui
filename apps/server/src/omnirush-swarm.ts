/**
 * Sub-agent swarms: the limits and the coordination text shared by the
 * injected engine config (omnirush-runtime-config.ts), the swarm engine
 * plugin (opencode-plugins/omnirush-swarm.ts) and the collector.
 *
 * A swarm is the main agent delegating to sub-agents that may delegate
 * again, every level coordinating through one `swarm.md` board at the
 * workspace root. The bundled engine (opencode 1.18.32) counts sub-agent
 * layers from the main session through `parentID` and refuses the task tool
 * at `subagent_depth`; it has no fan-out limit of its own, so the plugin adds
 * one.
 *
 * Kept dependency-free: the engine plugin bundle imports it.
 */

/**
 * Sub-agent layers below the main session (Claude Code's default, too):
 * children, grandchildren and great-grandchildren; the third layer can no
 * longer delegate. Equal to MAX_COLLECTOR_CHILD_SESSION_DEPTH, so every
 * layer the engine allows is captured.
 */
export const OMNIRUSH_SUBAGENT_DEPTH = 3;

/**
 * Sub-agents of one main session running at once, and started per turn: no
 * cap by owner decision (2026-09-24: "one should spawn as many as
 * required"); only the depth stays bounded.
 */
export const OMNIRUSH_SWARM_MAX_RUNNING = Number.POSITIVE_INFINITY;
export const OMNIRUSH_SWARM_MAX_PER_TURN = Number.POSITIVE_INFINITY;

/** The coordination board, relative to the workspace root. */
export const OMNIRUSH_SWARM_FILE = "swarm.md";

/**
 * The main agent's swarm instructions (part of OMNIRUSH_AGENT_PROMPT). A
 * swarm is the model's call for large work that splits into independent
 * parts; small prompts are answered directly.
 */
export const OMNIRUSH_SWARM_PROMPT = `## Sub-agent swarms

Most requests need no sub-agents, or one or two task calls. Run a swarm only when the user asks for one, or when the work is large and splits into several independent parts that each take real effort (a multi-module change, a broad investigation, parallel research with a review pass). Never start a swarm for a small or quick request.

A swarm is coordinated through \`${OMNIRUSH_SWARM_FILE}\` at the workspace root:
1. Before delegating, create or update \`${OMNIRUSH_SWARM_FILE}\` with: \`# Goal\` (one paragraph), \`## Tasks\` (a table: id, task, owner, status, result; ids like T1, T2, and T1.1 for a sub-task of T1; status is todo, running, done or blocked), \`## Findings\` (shared facts, one bullet each, with the task id), \`## Decisions\` (choices every agent must follow).
2. Give each sub-agent one task id. Its task-tool prompt names the id, the task, and says: read \`${OMNIRUSH_SWARM_FILE}\` first; set your row to running; when done, set it to done with a one-line result and append your findings under your id; edit only your own rows and sections; report back briefly.
3. Sub-agents may split their own task: they add sub-task rows (T1.1, T1.2) and give the same instructions to their own sub-agents. Sub-agents nest at most ${OMNIRUSH_SUBAGENT_DEPTH} layers deep. There is no limit on how many run at once or start per turn: start as many as the work needs, and no more.
4. Launch independent tasks in parallel (several task calls in one message); give tasks that edit the same files to one agent.
5. When every task is done, read \`${OMNIRUSH_SWARM_FILE}\`, check and merge the results, record the outcome under \`## Decisions\` or a final \`## Summary\`, and answer the user. Keep \`${OMNIRUSH_SWARM_FILE}\` in the workspace unless the user asks you to remove it.`;

/**
 * System text for a sub-agent session while `swarm.md` exists: every layer
 * follows the board even when a prompt forgot to say so.
 */
export function omnirushSwarmSubagentNote(depth: number): string {
  const canDelegate = depth < OMNIRUSH_SUBAGENT_DEPTH;
  return [
    `You are a sub-agent (layer ${depth} of at most ${OMNIRUSH_SUBAGENT_DEPTH}) in a swarm coordinated through \`${OMNIRUSH_SWARM_FILE}\` at the workspace root.`,
    `Read \`${OMNIRUSH_SWARM_FILE}\` before you start. Find your task id in your prompt (or the row that matches your task), set its status to running, and when you finish set it to done with a one-line result and append your findings under your task id. Edit only your own rows and sections, and re-read the file right before each edit because other agents write to it too.`,
    canDelegate
      ? "If your task splits into independent parts that each take real effort, you may delegate them with the task tool: add sub-task rows (for example T1.1, T1.2) first and give each sub-agent the same instructions. Otherwise do the work yourself."
      : "You cannot delegate further: do the work yourself.",
  ].join("\n");
}
