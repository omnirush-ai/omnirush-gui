// Which agent conversations ask before each new website, in every mode: Work
// chats (any account) and every chat of a company account. Their tabs use the
// browser's sign-ins, which can include ones copied from another browser, so
// the first visit to each site in a tab asks with the usual "Allow website
// navigation?" (browser-task.mjs). Every other chat follows its mode as before.
//
// A Work chat is one whose folder is the account's Work folder
// (<userData>/work/<accountId>, apps/server/src/work/work.ts isWorkRoot). The
// engine's browser tools and the app commands name the chat's folder; nothing
// the agent writes does. A company account is one whose last capabilities
// answer had a `work.enterprise` block (<userData>/work/server.json).
import { readFileSync } from "node:fs";
import path from "node:path";

const ACCOUNT_FOLDER = /^[A-Za-z0-9_-]{1,128}$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `directory` is an account's Work folder under `workDir` (the server's isWorkRoot). */
export function isWorkChatDirectory(workDir, directory) {
  if (typeof workDir !== "string" || !workDir || typeof directory !== "string" || !directory) return false;
  const root = path.resolve(directory);
  const parent = path.dirname(root);
  return parent === path.resolve(workDir) && ACCOUNT_FOLDER.test(path.basename(root));
}

/**
 * The company of the signed-in account as last seen ({ id, name }), or null
 * for every other account. A file that cannot be read means none.
 */
export function rememberedCompany(workDir, readFile = (file) => readFileSync(file, "utf8")) {
  let saved;
  try {
    saved = JSON.parse(readFile(path.join(workDir, "server.json")));
  } catch {
    return null;
  }
  const enterprise = isRecord(saved) && isRecord(saved.block) && isRecord(saved.block.enterprise) ? saved.block.enterprise : null;
  if (!enterprise) return null;
  const org = isRecord(enterprise.org) ? enterprise.org : {};
  return {
    id: typeof org.id === "string" ? org.id.slice(0, 64) : null,
    name: typeof org.name === "string" && org.name.trim() ? org.name.trim().slice(0, 200) : null,
  };
}

/**
 * @param {{ workDir: string, readFile?: (file: string) => string }} options
 */
export function createBrowserSiteGuard({ workDir, readFile = undefined }) {
  const workSessions = new Set();

  /** Remember a chat as a Work chat when its request names the Work folder. Never forgets one within a launch. */
  function noteSession(input) {
    const sessionId = isRecord(input) && typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    const directory = isRecord(input) ? input.directory : null;
    if (!sessionId || !isWorkChatDirectory(workDir, directory)) return;
    workSessions.add(sessionId);
  }

  function company() {
    return rememberedCompany(workDir, readFile);
  }

  /** Whether this chat asks before each new website, whatever its mode. */
  function sitesAsk(sessionId) {
    return workSessions.has(String(sessionId ?? "")) || company() !== null;
  }

  return { noteSession, sitesAsk, company };
}
