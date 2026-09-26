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
 * The `.omnirush/.gitignore` entries that keep the board, its archive, that
 * file itself and the `.ignore` file next to it out of git status and out of
 * the collector's snapshots (the board still reaches the trace through the
 * tool calls that write it).
 */
export const OMNIRUSH_SWARM_GITIGNORE_LINES = ["/.gitignore", "/.ignore", "/swarm.md", "/swarms/"] as const;

/**
 * The `.omnirush/.ignore` entries: ripgrep, which the engine's grep and glob
 * tools run with hidden files included, honours `.ignore` files in every
 * folder, git repository or not (a `.gitignore` only counts inside one), so a
 * search over the workspace never pulls a board into a model's context.
 */
export const OMNIRUSH_SWARM_IGNORE_LINES = ["/.ignore", "/swarm.md", "/swarms/"] as const;

/** Finished boards kept in `.omnirush/swarms/`; older ones are deleted when a board is archived. */
export const OMNIRUSH_SWARM_ARCHIVES_KEPT = 10;

/** Fewest parallel sub-agents that make a swarm (fewer never get a board). */
export const OMNIRUSH_SWARM_MIN_AGENTS = 3;

/**
 * Board size limits. Every agent's view of the board is re-sent to the model
 * on each of its steps, so the board stays a status board: a task table with
 * one-line cells, a few one-line findings per task and one-line decisions.
 * Full reports travel in the task results, never on the board.
 */
export const OMNIRUSH_SWARM_CELL_MAX_CHARS = 160;
export const OMNIRUSH_SWARM_LINE_MAX_CHARS = 240;
export const OMNIRUSH_SWARM_FINDINGS_PER_TASK = 3;
export const OMNIRUSH_SWARM_GOAL_MAX_CHARS = 600;

/** The engine tool (from the swarm plugin) that sub-agents use to read their rows and update the board. */
export const OMNIRUSH_SWARM_TOOL_NAME = "swarm_board";

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

The board is \`${OMNIRUSH_SWARM_FILE}\` in the workspace, never a file in the project root. It is a short status board, not a report: every agent re-reads it, so keep it small. omnirush.ai keeps it out of git and clears it when your turn ends. Ignore any \`swarm.md\` in the project root: it is not this swarm's board.

1. Before delegating, create \`${OMNIRUSH_SWARM_FILE}\` (replace it if one exists) with: \`# Goal\` (at most 3 sentences), \`## Tasks\` (a table: id, task, owner, status, result; ids like T1, T2, and T1.1 for a sub-task of T1; status is todo, running, done or blocked; every cell one short line), \`## Findings\` (empty) and \`## Decisions\` (choices every agent must follow, one line each).
2. Give each sub-agent one task id. Its task-tool prompt names the id and the task, and says: use the \`${OMNIRUSH_SWARM_TOOL_NAME}\` tool with your task id (it shows your row and the Decisions, and sets your status, one-line result and at most ${OMNIRUSH_SWARM_FINDINGS_PER_TASK} one-line findings); do not read or edit the board file; report back briefly.
3. Sub-agents may split their own task: they add sub-task rows (T1.1, T1.2) with \`${OMNIRUSH_SWARM_TOOL_NAME}\` and give the same instructions to their own sub-agents. Sub-agents nest at most ${OMNIRUSH_SUBAGENT_DEPTH} layers deep. There is no limit on how many run at once or start per turn: start as many as the work needs, and no more.
4. Launch independent tasks in parallel (several task calls in one message); give tasks that edit the same files to one agent.
5. When every task is done, read \`${OMNIRUSH_SWARM_FILE}\` once, check the results against the task reports, and answer the user. Do not move, copy or archive the board: omnirush.ai does that when the turn ends. Board cells over ${OMNIRUSH_SWARM_CELL_MAX_CHARS} characters, lines over ${OMNIRUSH_SWARM_LINE_MAX_CHARS} and findings past ${OMNIRUSH_SWARM_FINDINGS_PER_TASK} per task are cut.`;

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
 * a prompt forgot to say so. It never changes during a session, so it never
 * invalidates the model's prompt cache; the board itself comes from the tool.
 */
export function omnirushSwarmSubagentNote(depth: number): string {
  const canDelegate = depth < OMNIRUSH_SUBAGENT_DEPTH;
  return [
    `You are a sub-agent (layer ${depth} of at most ${OMNIRUSH_SUBAGENT_DEPTH}) in a swarm coordinated through the board \`${OMNIRUSH_SWARM_FILE}\`.`,
    `Do not read, search or edit the board file: use the \`${OMNIRUSH_SWARM_TOOL_NAME}\` tool with your task id (from your prompt); it answers with your rows and the Decisions. Call it once when you start (status running) and once when you finish (status done, a one-line result, at most ${OMNIRUSH_SWARM_FINDINGS_PER_TASK} one-line findings other agents need). Put details in your final report, not on the board. Do not move or archive the board: omnirush.ai does that.`,
    canDelegate
      ? `If your task splits into independent parts that each take real effort, you may delegate them with the task tool: add sub-task rows (for example T1.1, T1.2) with \`${OMNIRUSH_SWARM_TOOL_NAME}\` first and give each sub-agent the same instructions. Otherwise do the work yourself.`
      : "You cannot delegate further: do the work yourself.",
  ].join("\n");
}

export const OMNIRUSH_SWARM_STATUSES = ["todo", "running", "done", "blocked"] as const;
export type SwarmTaskStatus = (typeof OMNIRUSH_SWARM_STATUSES)[number];

export type SwarmBoardUpdate = {
  task: string;
  status?: SwarmTaskStatus;
  result?: string;
  findings?: string[];
  subtasks?: Array<{ id: string; task: string }>;
};

type Table = { header: number; separator: number; rows: number[]; columns: { id: number; task: number; owner: number; status: number; result: number; count: number } };

/** One line, whitespace collapsed, at most `max` characters (cut with an ellipsis). */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const cellsOf = (line: string): string[] => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
const rowOf = (cells: string[]): string => `| ${cells.join(" | ")} |`;
const isSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const heading = (line: string) => /^(#{1,6})\s+(.*)$/.exec(line.trim());
const sectionName = (line: string) => {
  const match = heading(line);
  return match && match[1].length === 2 ? match[2].trim().toLowerCase() : null;
};
/** A task id at the start of a table cell or finding: T1, T1.2, **T3**, [T2]. */
const TASK_ID = /^[\s*_[(`]*(T\d+(?:\.\d+)*)\b/i;
const normalId = (id: string) => id.trim().toUpperCase();

/** The first task table in the board (a markdown table whose header names an id and a status column). */
function findTable(lines: string[]): Table | null {
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!lines[i].trim().startsWith("|") || !isSeparator(lines[i + 1])) continue;
    const names = cellsOf(lines[i]).map((cell) => cell.toLowerCase().replace(/[^a-z]/g, ""));
    const find = (...keys: string[]) => names.findIndex((name) => keys.includes(name));
    const columns = {
      id: Math.max(find("id", "task id", "taskid"), 0),
      task: find("task", "description", "title"),
      owner: find("owner", "agent", "assignee"),
      status: find("status", "state"),
      result: find("result", "results", "outcome", "summary"),
      count: names.length,
    };
    if (columns.status < 0) continue;
    const rows: number[] = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j += 1) rows.push(j);
    return { header: i, separator: i + 1, rows, columns };
  }
  return null;
}

/**
 * The board cut to its limits: one-line table cells, one-line findings and
 * decisions (at most OMNIRUSH_SWARM_FINDINGS_PER_TASK per task; code blocks,
 * paragraphs and nested bullets under Findings dropped) and a short goal.
 * Other sections are left as they are. Returns the text unchanged when it is
 * already within the limits.
 */
export function compactSwarmBoard(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const table = findTable(lines);
  const tableRows = new Set(table?.rows ?? []);
  let section: string | null = null;
  let fence = false;
  let goalChars = 0;
  let findingTask: string | null = null;
  const perTask = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const h = heading(line);
    if (h && !fence) {
      section = sectionName(line) ?? (h[1].length === 1 ? "goal" : section);
      findingTask = section === "findings" && h[1].length > 2 ? (TASK_ID.exec(h[2])?.[1] ?? null) : section === "findings" ? findingTask : null;
      if (h[1].length === 1) goalChars = 0;
      out.push(line);
      continue;
    }
    if (tableRows.has(i)) {
      const cells = cellsOf(line);
      out.push(cells.some((cell) => cell.length > OMNIRUSH_SWARM_CELL_MAX_CHARS)
        ? rowOf(cells.map((cell) => oneLine(cell, OMNIRUSH_SWARM_CELL_MAX_CHARS)))
        : line);
      continue;
    }
    if (section === "findings") {
      if (/^\s*```/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      const bullet = /^[-*+]\s+(.*)$/.exec(line);
      if (!bullet) {
        if (!line.trim()) out.push(line);
        continue;
      }
      const task = normalId(TASK_ID.exec(bullet[1])?.[1] ?? findingTask ?? "?");
      const count = (perTask.get(task) ?? 0) + 1;
      perTask.set(task, count);
      if (count > OMNIRUSH_SWARM_FINDINGS_PER_TASK) continue;
      out.push(`- ${oneLine(bullet[1], OMNIRUSH_SWARM_LINE_MAX_CHARS)}`);
      continue;
    }
    if (section === "decisions") {
      const bullet = /^[-*+]\s+(.*)$/.exec(line);
      out.push(bullet ? `- ${oneLine(bullet[1], OMNIRUSH_SWARM_LINE_MAX_CHARS)}` : line.length > OMNIRUSH_SWARM_LINE_MAX_CHARS ? oneLine(line, OMNIRUSH_SWARM_LINE_MAX_CHARS) : line);
      continue;
    }
    if (section === "goal") {
      if (goalChars >= OMNIRUSH_SWARM_GOAL_MAX_CHARS && line.trim()) continue;
      const room = OMNIRUSH_SWARM_GOAL_MAX_CHARS - goalChars;
      goalChars += line.length;
      out.push(line.length > room ? oneLine(line, Math.max(room, 1)) : line);
      continue;
    }
    out.push(line);
  }
  const next = out.join("\n").replace(/\n{3,}/g, "\n\n");
  return next === text ? text : next;
}

/** The lines of one `## <name>` section, heading excluded; null when the board has none. */
function sectionLines(lines: string[], name: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => sectionName(line) === name);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !(heading(lines[end]) && (heading(lines[end])?.[1].length ?? 3) <= 2)) end += 1;
  return { start, end };
}

/**
 * What one agent needs from the board: the task table's header with its own
 * rows (its id and its sub-tasks) and the Decisions. Much smaller than the
 * board, whose other rows and findings belong to other agents.
 */
export function swarmBoardView(text: string, taskId: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const id = normalId(taskId);
  const parts: string[] = [];
  const table = findTable(lines);
  if (table) {
    const mine = table.rows.filter((row) => {
      const rowId = normalId(cellsOf(lines[row])[table.columns.id] ?? "");
      return rowId === id || rowId.startsWith(`${id}.`);
    });
    parts.push(mine.length ? [lines[table.header], lines[table.separator], ...mine.map((row) => lines[row])].join("\n") : `(no row for ${id} yet)`);
  }
  const decisions = sectionLines(lines, "decisions");
  const body = decisions ? lines.slice(decisions.start + 1, decisions.end).filter((line) => line.trim()) : [];
  parts.push(`Decisions:\n${body.length ? body.join("\n") : "(none)"}`);
  return parts.join("\n");
}

/**
 * Applies one agent's update to the board: its row's status and result (a
 * row is added when it has none), new sub-task rows, and findings appended
 * under Findings as `- <id>: <text>`. The result is compacted.
 */
export function updateSwarmBoard(text: string, update: SwarmBoardUpdate): string {
  const id = normalId(update.task);
  let lines = text.replace(/\r\n/g, "\n").split("\n");
  let table = findTable(lines);
  if (!table) {
    const tasks = ["## Tasks", "| id | task | owner | status | result |", "|---|---|---|---|---|"];
    const at = sectionLines(lines, "tasks");
    lines = at ? [...lines.slice(0, at.start), ...tasks, ...lines.slice(at.start + 1)] : [...lines, "", ...tasks];
    table = findTable(lines);
    if (!table) return text;
  }
  const { columns } = table;
  const blank = () => Array.from({ length: columns.count }, () => "");
  const rowIndex = (rowId: string) => table?.rows.find((row) => normalId(cellsOf(lines[row])[columns.id] ?? "") === rowId) ?? -1;
  const insertRow = (cells: string[]) => {
    const at = (table?.rows.at(-1) ?? table?.separator ?? lines.length - 1) + 1;
    lines.splice(at, 0, rowOf(cells));
    table = findTable(lines);
  };
  if (update.status || update.result !== undefined || rowIndex(id) < 0) {
    let row = rowIndex(id);
    if (row < 0) {
      const cells = blank();
      cells[columns.id] = id;
      if (columns.status >= 0) cells[columns.status] = "todo";
      insertRow(cells);
      row = rowIndex(id);
    }
    const cells = cellsOf(lines[row]);
    while (cells.length < columns.count) cells.push("");
    if (update.status && columns.status >= 0) cells[columns.status] = update.status;
    if (update.result !== undefined && columns.result >= 0) cells[columns.result] = oneLine(update.result.replace(/\|/g, "/"), OMNIRUSH_SWARM_CELL_MAX_CHARS);
    lines[row] = rowOf(cells);
  }
  for (const sub of update.subtasks ?? []) {
    const subId = normalId(sub.id);
    if (!subId || rowIndex(subId) >= 0) continue;
    const cells = blank();
    cells[columns.id] = subId;
    if (columns.task >= 0) cells[columns.task] = oneLine(sub.task.replace(/\|/g, "/"), OMNIRUSH_SWARM_CELL_MAX_CHARS);
    if (columns.status >= 0) cells[columns.status] = "todo";
    insertRow(cells);
  }
  const findings = (update.findings ?? []).map((finding) => finding.trim()).filter(Boolean);
  if (findings.length) {
    let at = sectionLines(lines, "findings");
    if (!at) {
      const decisions = sectionLines(lines, "decisions");
      const insert = decisions ? decisions.start : lines.length;
      lines.splice(insert, 0, "## Findings", "");
      at = sectionLines(lines, "findings");
    }
    if (at) {
      let end = at.end;
      while (end > at.start + 1 && !lines[end - 1].trim()) end -= 1;
      lines.splice(end, 0, ...findings.map((finding) => `- ${id}: ${oneLine(finding.replace(TASK_ID, "").replace(/^\s*[:\-–]\s*/, ""), OMNIRUSH_SWARM_LINE_MAX_CHARS)}`));
    }
  }
  return compactSwarmBoard(lines.join("\n"));
}

