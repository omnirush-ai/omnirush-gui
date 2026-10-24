// Ported from the CLI (omnirush-cli assets/opencode-box-plugin.js,
// feat/local-box); keep the two in step. Desktop: a project's box is used
// only when the desktop lists it (box/plugin-lib.ts desktopProjects()).
//
// Engine plugin for a project whose OmniRush box is on (box/). The engine
// runs here, on this machine; its shell tool runs in the box (the engine's
// shell is boxsh, which reads OMNIRUSH_BOX_KEY). This plugin:
//
// - gives each shell call the box key (one engine serves several projects)
//   and the call and session ids the package-manager wrappers write into
//   their lines;
// - keeps the engine's file tools to the project folder and the engine's own
//   folders: everything else is the box's (its /tmp, its HOME), which the
//   file tools would read from this machine instead. The agent is told to
//   use the shell for those. This machine's files outside the project
//   (keys, tokens, other projects) stay out of the session either way;
// - says in the system prompt that commands run on Linux in a container,
//   with the project folder at the same path.
//
// A project whose box is off (not listed, no record, or state "off") is left
// alone. The engine calls every function this module exports: export only
// the plugin.

import path from "node:path";

import { BOX_HEADER } from "../model-modes/model-modes.mjs";
import { BOX_NOTE, desktopProjects, engineDirs, FILE_TOOLS, keyOf, record, toolPaths, within } from "../box/plugin-lib.js";

/** The engine client's one call used here: a chat's parent (a sub-agent's chat has one). */
type SessionReader = { session: { get: (options: { path: { id: string } }) => Promise<{ data?: { parentID?: string } | null } | undefined> } };

export const OmniRushBox = async ({ directory, client }: { directory?: string; client?: SessionReader }) => {
  const root = path.resolve(directory || process.cwd());
  const key = keyOf(root);
  // A chat's top chat (sub-agents run in child chats): asked once per chat, at most 8 levels up.
  const tops = new Map<string, Promise<string>>();
  const topOf = (id: string): Promise<string> => {
    const known = tops.get(id);
    if (known) return known;
    const found = (async () => {
      let current = id;
      for (let level = 0; level < 8 && client; level += 1) {
        const parent = (await client.session.get({ path: { id: current } }).catch(() => undefined))?.data?.parentID;
        if (!parent) break;
        current = parent;
      }
      return current;
    })();
    tops.set(id, found);
    return found;
  };
  const current = async (sessionID?: string) => {
    const listed = desktopProjects();
    if (!listed.keys.has(key)) return null;
    // A chat that ran on this machine before the box was on stays there (with its sub-agents).
    if (sessionID && listed.nativeChats.size && (listed.nativeChats.has(sessionID) || listed.nativeChats.has(await topOf(sessionID)))) return null;
    const rec = record(key);
    return rec && rec.state !== "off" ? { ...rec, pkglogDir: listed.pkglogDir } : null;
  };
  const active = async (sessionID?: string) => Boolean(await current(sessionID));
  const allowed = [root, ...engineDirs()];
  return {
    "shell.env": async (input: { callID?: string; sessionID?: string }, output: { env: Record<string, string> }) => {
      const rec = await current(input.sessionID);
      if (!rec) return;
      output.env.OMNIRUSH_BOX_KEY = key;
      // Desktop: box chats note installs in their own raw folder (boxsh forwards it into the box).
      if (rec.pkglogDir) output.env.OMNIRUSH_PKGLOG_DIR = rec.pkglogDir;
      if (input.callID) output.env.OMNIRUSH_CALL = String(input.callID);
      if (input.sessionID) output.env.OMNIRUSH_SESSION = String(input.sessionID);
    },
    // A box chat's model requests say so (X-OmniRush-Box): the gateway judges their model in the box mode (model-modes/).
    "chat.headers": async (input: { sessionID?: string }, output: { headers?: Record<string, string> }) => {
      if (output?.headers && (await active(input?.sessionID))) output.headers[BOX_HEADER] = "1";
    },
    "tool.execute.before": async (input: { tool: string; sessionID?: string }, output: { args?: Record<string, unknown> }) => {
      if (!FILE_TOOLS.has(input.tool) || !(await active(input.sessionID))) return;
      for (const raw of toolPaths(input.tool, output.args ?? {})) {
        const full = path.resolve(root, raw);
        if (allowed.some((dir) => within(full, dir))) continue;
        throw new Error(`${raw} is outside the project folder. This session runs in a sandbox: files outside ${root} live inside the Linux container, not where this tool can see them. Use the shell tool (cat, ls, sed, tee, ...) to read or change them.`);
      }
    },
    "experimental.chat.system.transform": async (input: { sessionID?: string }, output: { system?: unknown }) => {
      const rec = await current(input.sessionID);
      if (!rec || !Array.isArray(output.system)) return;
      // In place: the engine keeps its own reference to this array.
      for (let i = 0; i < output.system.length; i += 1) {
        const line = output.system[i];
        if (typeof line === "string") output.system[i] = line.replace(/^(\s*Platform:\s*)(darwin|win32|linux)\s*$/m, "$1linux");
      }
      output.system.push(BOX_NOTE(root, Number(rec.uid) || 0, typeof rec.croot === "string" ? rec.croot : root, rec.shadows_note));
    },
  };
};
