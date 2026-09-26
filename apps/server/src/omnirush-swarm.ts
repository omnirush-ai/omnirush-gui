/**
 * Sub-agent swarms: the limits and the coordination text shared by the
 * injected engine config (omnirush-runtime-config.ts), the swarm engine
 * plugin (opencode-plugins/omnirush-swarm.ts) and the collector.
 *
 * A swarm is the main agent running 3 or more sub-agents in parallel (or
 * the user asking for one), sub-agents that may delegate again, every level
 * coordinating through one `.omnirush/swarm.md` board. Only a swarm gets a
 * board: the procedure is the on-demand omnirush-swarm skill, and the
 * always-on prompt only says when to load it. The bundled engine (opencode
 * 1.18.32) counts sub-agent layers from the main session through `parentID`
 * and refuses the task tool at `subagent_depth`; it has no fan-out limit of
 * its own, so the plugin adds one.
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

/**
 * Private request headers the swarm plugin puts on a sub-agent's model
 * request when the sub-agent runs on a model picked for sub-agents
 * (omnirush-subagent-model.ts): the main model to fall back to, its effort,
 * and the main session. The local gateway broker consumes them; they never
 * leave the machine.
 */
export const SUBAGENT_FALLBACK_MODEL_HEADER = "x-omnirush-subagent-fallback-model";
export const SUBAGENT_FALLBACK_EFFORT_HEADER = "x-omnirush-subagent-fallback-effort";
export const SUBAGENT_ROOT_SESSION_HEADER = "x-omnirush-subagent-root";

/** The collector trace event recording that a sub-agent ran on the main model instead of the picked one. */
export const SUBAGENT_MODEL_FALLBACK_TRACE = "subagent.model_fallback";

/**
 * The folder omnirush.ai keeps its own workspace files in, relative to the
 * workspace root. Only the board and its archive are kept out of git there
 * (OMNIRUSH_SWARM_GITIGNORE_LINES); anything else a user puts in it is theirs.
 */
export const OMNIRUSH_WORKSPACE_DIR = ".omnirush";

/**
 * The coordination board of a running swarm, relative to the workspace root.
 * It lives in `.omnirush/`, never in the project root: a `swarm.md` at the
 * root is a user file (or one an older version left) and is left alone.
 */
export const OMNIRUSH_SWARM_FILE = `${OMNIRUSH_WORKSPACE_DIR}/swarm.md`;

/** Where finished boards go (`<stamp>.md`), relative to the workspace root. */
export const OMNIRUSH_SWARM_ARCHIVE_DIR = `${OMNIRUSH_WORKSPACE_DIR}/swarms`;

/**
 * The `.omnirush/.gitignore` entries that keep the board, its archive and
 * that file itself out of git status and out of the collector's snapshots
 * (the board still reaches the trace through the tool calls that write it).
 */
export const OMNIRUSH_SWARM_GITIGNORE_LINES = ["/.gitignore", "/swarm.md", "/swarms/"] as const;

/** Fewest parallel sub-agents that make a swarm (fewer never get a board). */
export const OMNIRUSH_SWARM_MIN_AGENTS = 3;

/** The on-demand skill that carries the swarm procedure. */
export const OMNIRUSH_SWARM_SKILL_NAME = "omnirush-swarm";

export const OMNIRUSH_SWARM_SKILL_DESCRIPTION = `Required before starting ${OMNIRUSH_SWARM_MIN_AGENTS} or more sub-agents for one request (a swarm, or the user asks for several agents): the shared-board procedure. Never for 1-2 sub-agents or a small request.`;

/**
 * The main agent's always-on swarm text (part of OMNIRUSH_AGENT_PROMPT). The
 * procedure itself is the omnirush-swarm skill, loaded only for a swarm.
 */
export const OMNIRUSH_SWARM_PROMPT = `## Sub-agent swarms

Before you start ${OMNIRUSH_SWARM_MIN_AGENTS} or more sub-agents for one request (large work that splits into ${OMNIRUSH_SWARM_MIN_AGENTS}+ independent parts, or the user asks for a swarm or for several agents), load the \`${OMNIRUSH_SWARM_SKILL_NAME}\` skill first and follow it. Otherwise answer directly, or use at most 1-2 sub-agents with the task tool and no board or coordination file.`;

/** The body of the omnirush-swarm skill (without frontmatter). */
export const OMNIRUSH_SWARM_SKILL = `# Sub-agent swarm

Use this only for a real swarm: ${OMNIRUSH_SWARM_MIN_AGENTS} or more sub-agents working in parallel, or the user asked for a swarm or for several agents. For 1-2 sub-agents, stop here: call the task tool directly and do not create or touch a board.

The board is \`${OMNIRUSH_SWARM_FILE}\` in the workspace, never a file in the project root. omnirush.ai keeps \`${OMNIRUSH_SWARM_FILE}\` and \`${OMNIRUSH_SWARM_ARCHIVE_DIR}/\` out of git. Ignore any \`swarm.md\` in the project root: it is not this swarm's board.

1. If \`${OMNIRUSH_SWARM_FILE}\` already exists, it is left over from an earlier swarm: move it to \`${OMNIRUSH_SWARM_ARCHIVE_DIR}/<YYYYMMDD-HHMMSS>.md\` and start a fresh board.
2. Before delegating, create \`${OMNIRUSH_SWARM_FILE}\` with: \`# Goal\` (one paragraph), \`## Tasks\` (a table: id, task, owner, status, result; ids like T1, T2, and T1.1 for a sub-task of T1; status is todo, running, done or blocked), \`## Findings\` (shared facts, one bullet each, with the task id), \`## Decisions\` (choices every agent must follow).
3. Give each sub-agent one task id. Its task-tool prompt names the id, the task, and says: read \`${OMNIRUSH_SWARM_FILE}\` first; set your row to running; when done, set it to done with a one-line result and append your findings under your id; edit only your own rows and sections; report back briefly.
4. Sub-agents may split their own task: they add sub-task rows (T1.1, T1.2) and give the same instructions to their own sub-agents. Sub-agents nest at most ${OMNIRUSH_SUBAGENT_DEPTH} layers deep. There is no limit on how many run at once or start per turn: start as many as the work needs, and no more.
5. Launch independent tasks in parallel (several task calls in one message); give tasks that edit the same files to one agent.
6. When every task is done, read \`${OMNIRUSH_SWARM_FILE}\`, check and merge the results, and answer the user.
7. Then archive the board: move \`${OMNIRUSH_SWARM_FILE}\` to \`${OMNIRUSH_SWARM_ARCHIVE_DIR}/<YYYYMMDD-HHMMSS>.md\` (create the folder if needed), so no later request picks it up. If the user asked to keep the board, name the archived path in your answer.`;

/** The omnirush-swarm skill's SKILL.md. */
export function omnirushSwarmSkillMarkdown(): string {
  return `---\nname: ${OMNIRUSH_SWARM_SKILL_NAME}\ndescription: ${JSON.stringify(OMNIRUSH_SWARM_SKILL_DESCRIPTION)}\n---\n\n${OMNIRUSH_SWARM_SKILL}\n`;
}

/** A board archive name for `date`: `.omnirush/swarms/YYYYMMDD-HHMMSS.md` (UTC). */
export function omnirushSwarmArchiveName(date: Date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${OMNIRUSH_SWARM_ARCHIVE_DIR}/${stamp}.md`;
}

/**
 * System text for a sub-agent session of a running swarm (its main session
 * started one and the board exists): every layer follows the board even when
 * a prompt forgot to say so.
 */
export function omnirushSwarmSubagentNote(depth: number): string {
  const canDelegate = depth < OMNIRUSH_SUBAGENT_DEPTH;
  return [
    `You are a sub-agent (layer ${depth} of at most ${OMNIRUSH_SUBAGENT_DEPTH}) in a swarm coordinated through \`${OMNIRUSH_SWARM_FILE}\` in the workspace.`,
    `Read \`${OMNIRUSH_SWARM_FILE}\` before you start. Find your task id in your prompt (or the row that matches your task), set its status to running, and when you finish set it to done with a one-line result and append your findings under your task id. Edit only your own rows and sections, and re-read the file right before each edit because other agents write to it too. Do not move or archive the board: the main agent does that.`,
    canDelegate
      ? "If your task splits into independent parts that each take real effort, you may delegate them with the task tool: add sub-task rows (for example T1.1, T1.2) first and give each sub-agent the same instructions. Otherwise do the work yourself."
      : "You cannot delegate further: do the work yourself.",
  ].join("\n");
}
