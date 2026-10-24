// Ported from the CLI (omnirush-cli src/box/required.js); keep the two in
// step. required.json (the rules and the texts) is the same file in both,
// listed in PARITY.sha256.
//
// The mandatory sandbox: a server answer with `local_box.required: true`
// puts every new chat in the project's box. What stays out: chats started on
// this machine before (kept_old_chat), projects that only build on this OS
// (host_only), OMNIRUSH_BOX=0 (env_off), and machines where the box cannot
// run (the `required_fallback` answer; the setup screen says why).

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, type Dirent } from "node:fs";
import path from "node:path";

import { HOST_BUILD_RULES, hostBuilds, hostRules } from "./host-builds.js";
import rules from "./required.json" with { type: "json" };

export type RequiredFallback = "native" | "native_uncounted";
export type RequiredReason = "box" | "kept_old_chat" | "native_model" | "host_only" | "env_off" | "setup_needed" | "cannot_run" | "setup_declined";
export type CannotRunWhy = keyof typeof rules.texts.why;
type HostOnlyPattern = { name?: string; suffix?: string; contains: string };
type HostOnlyRules = { dirs_suffix: string[]; files: string[]; file_patterns: HostOnlyPattern[] };

export const REQUIRED_RULES = rules;

/** The fallback a server answer names (`required_fallback`), else the default. */
export function requiredFallback(value: unknown): RequiredFallback {
  return value === "native" || value === "native_uncounted" ? value : "native";
}

/** The required part of a chat's launch record (required.json launch_record). */
export type RequiredLaunch = { required: true; capable?: boolean; fallback?: RequiredFallback };

/**
 * The required part of a chat's box.plan outcome (required.json
 * launch_record; CLI: required.js requiredLaunch): { required, capable,
 * fallback } so the server can tell a machine that can't run the box
 * (counted in full, fallback native) from one where it was turned off or
 * the setup declined (the server's required_fallback).
 */
export function requiredLaunch(reason: string, { native, serverFallback }: { native: boolean; serverFallback?: unknown }): RequiredLaunch {
  const record = rules.launch_record;
  if (!native) return { required: true, capable: true };
  if (record.kept.includes(reason)) return { required: true, fallback: "native" };
  if (record.opted_out.includes(reason)) return { required: true, capable: true, fallback: requiredFallback(serverFallback) };
  return { required: true, capable: false, fallback: "native" };
}

/** A desktop text of required.json with its `{name}` parts filled in. */
export function desktopText(key: keyof typeof rules.texts.desktop, vars: Record<string, string> = {}): string {
  return fill(rules.texts.desktop[key], vars);
}

/** Why the box cannot run here, in words (required.json texts.why). */
export function whyText(why: string | null | undefined): string | null {
  if (!why) return null;
  const texts: Record<string, string> = rules.texts.why;
  return texts[why] ?? null;
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (all, name: string) => vars[name] ?? all);
}

/** Read at most `max` bytes of a file as text (empty when it cannot be read). */
function head(file: string, max = 256 * 1024): string {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.toString("utf8", 0, n);
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function entries(dir: string, read: (dir: string) => Dirent[]): Dirent[] {
  try {
    return read(dir);
  } catch {
    return [];
  }
}

/**
 * A project that only builds on this OS (an Xcode project on macOS; a WPF,
 * WinForms or MAUI app, a C++ .vcxproj on Windows): its markers, the root
 * first, then one level down (CLI: required.js hostOnly), else null. Linux:
 * never. Bounded: a couple of directory reads and a few small files.
 */
export function hostOnlyProject(root: string, { platform = process.platform, readDir = (dir: string) => readdirSync(dir, { withFileTypes: true }), readHead = head, maxFiles = 40 }: { platform?: string; readDir?: (dir: string) => Dirent[]; readHead?: (file: string) => string; maxFiles?: number } = {}): { things: string[]; notice: string } | null {
  const table: Record<string, HostOnlyRules> = { darwin: rules.host_only.darwin, win32: rules.host_only.win32 };
  const set = table[platform];
  if (!set) return null;
  const things: string[] = [];
  let read = 0;
  const contains = (file: string, pattern: string) => {
    if (read >= maxFiles) return false;
    read += 1;
    return new RegExp(pattern).test(readHead(file));
  };
  const check = (dir: string, prefix: string) => {
    for (const entry of entries(dir, readDir)) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && set.dirs_suffix.some((suffix) => entry.name.endsWith(suffix))) { things.push(rel); continue; }
      if (!entry.isFile()) continue;
      if (set.files.includes(entry.name)) { things.push(rel); continue; }
      for (const pattern of set.file_patterns) {
        const named = pattern.name ? entry.name === pattern.name : pattern.suffix ? entry.name.endsWith(pattern.suffix) : false;
        if (named && contains(path.join(dir, entry.name), pattern.contains)) { things.push(rel); break; }
      }
    }
  };
  check(root, "");
  for (const entry of entries(root, readDir)) {
    if (things.length > 0) break;
    if (entry.isDirectory() && !entry.name.startsWith(".") && !rules.shadows.skip_dirs.includes(entry.name) && !set.dirs_suffix.some((suffix) => entry.name.endsWith(suffix))) check(path.join(root, entry.name), entry.name);
  }
  if (!things.length) return null;
  const host = HOST_BUILD_RULES.hosts[platform];
  return { things, notice: desktopText("host_only", { label: host?.label ?? platform, things: things.slice(0, 3).join(", "), machine: host?.machine ?? "this computer" }) };
}

// --- build-artefact shadows ------------------------------------------------------
// The box's own copy of each build folder on a macOS or Windows host (CLI:
// required.js shadowPlan; boxrun/boxd shadows.go in box/go do the mounts).

/** One shadowed folder: `path` project-relative (POSIX), `target` the folder inside the box, `id` its store name. */
export type ShadowBind = { path: string; existed: boolean; id?: string; target: string };
/** What a box start found: binds, env redirections ({store} filled in), the folder names, how the scan went. */
export type ShadowPlan = { binds: ShadowBind[]; env: Record<string, string>; dirs: string[]; scanned: number; truncated: boolean; ms: number };
/** record.json `shadows` (the converter maps these back and drops the host copies). */
export type ShadowRecord = { binds: Array<{ path: string; existed: boolean }>; env: Record<string, string> };

type ShadowLimits = { entries: number; ms: number; depth: number; max: number };

/** Whether boxes on this host get shadows at all (macOS, Windows; OMNIRUSH_BOX_SHADOWS=off: never). */
export function shadowsApply(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (String(env.OMNIRUSH_BOX_SHADOWS ?? "").trim().toLowerCase() === "off") return false;
  return rules.shadows.hosts.includes(platform);
}

/**
 * The store name of a project-relative path: sha256 of the path (POSIX
 * separators, "." for the project root), first 12 hex digits. boxd computes
 * the same for a folder it shadows mid-chat (box/go/cmd/boxd shadows.go).
 */
export function shadowId(rel: string | null | undefined): string {
  const clean = String(rel ?? "").split(/[\\/]+/).filter((p) => p && p !== ".").join("/") || ".";
  return createHash("sha256").update(clean).digest("hex").slice(0, 12);
}

/**
 * Whether `dir` satisfies one `when_any` marker: a file name in the folder
 * ("package.json"), a glob of one ("*.csproj"), a file inside the shadowed
 * folder itself ("pyvenv.cfg@dir"), or "@host-binaries" (host-builds.ts found
 * this host's programs in that folder).
 */
function markerHolds(marker: string, { names, target, rel, hostBinary }: { names: string[]; target: string; rel: string; hostBinary: (rel: string) => boolean }): boolean {
  if (marker === "@host-binaries") return hostBinary(rel);
  if (marker.endsWith("@dir")) return existsSync(path.join(target, marker.slice(0, -4)));
  if (marker.startsWith("*")) return names.some((name) => name.endsWith(marker.slice(1)));
  return names.includes(marker);
}

/**
 * The shadows a box on this host gets for `root` (box start): a bounded scan
 * (shadows.limits: entries, ms, depth; at most `max`) of the project's
 * folders against shadows.binds and, in the root only, shadows.env. Paths
 * are relative to the root (POSIX), `target` is the folder inside the box
 * (`croot`/path). `{store}` in an env value is `<store>/<shadowId(".")>`.
 */
export function shadowPlan(root: string, { platform = process.platform, croot = root, stateDir = null, env = process.env, now = Date.now, limits = rules.shadows.limits }: { platform?: string; croot?: string; stateDir?: string | null; env?: NodeJS.ProcessEnv; now?: () => number; limits?: ShadowLimits } = {}): ShadowPlan {
  const set = rules.shadows;
  const started = now();
  const out: ShadowPlan = { binds: [], env: {}, dirs: [], scanned: 0, truncated: false, ms: 0 };
  if (!shadowsApply(platform, env)) return out;
  let found: { hits: Array<{ kind: string; path: string }> } | null = null;
  const hostBinary = (rel: string) => {
    found ??= (() => { try { return hostBuilds(root, { platform, stateDir, env }); } catch { return { hits: [] }; } })();
    return (found.hits ?? []).some((hit) => hit.kind === "binary" && (hit.path === rel || hit.path.startsWith(`${rel}/`)));
  };
  const seen = new Set<string>();
  const over = () => {
    if (out.scanned > limits.entries || now() - started > limits.ms) out.truncated = true;
    return out.truncated;
  };
  const inBox = (rel: string) => (rel ? `${String(croot).replace(/\/+$/, "")}/${rel}` : croot);
  const visit = (dir: string, rel: string, depth: number) => {
    if (over()) return;
    let list: Dirent[];
    try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    out.scanned += list.length + 1;
    const names = list.filter((e) => e.isFile()).map((e) => e.name);
    if (depth === 0) {
      for (const rule of set.env) {
        if (!rule.when_any.some((m) => names.includes(m))) continue;
        for (const [name, value] of Object.entries(rule.set)) if (typeof value === "string") out.env[name] = value.replaceAll("{store}", `${set.store}/${shadowId(".")}`);
      }
    }
    for (const rule of set.binds) {
      if (out.binds.length >= limits.max) { out.truncated = true; break; }
      const relDir = rel ? `${rel}/${rule.dir}` : rule.dir;
      if (seen.has(relDir)) continue;
      const target = path.join(dir, ...rule.dir.split("/"));
      let existed = false;
      try { existed = statSync(target).isDirectory(); } catch { existed = false; }
      if (!existed && !rule.even_if_absent) continue;
      if (!rule.when_any.some((m) => markerHolds(m, { names, target, rel: relDir, hostBinary }))) continue;
      seen.add(relDir);
      out.binds.push({ path: relDir, existed, id: shadowId(relDir), target: inBox(relDir) });
      if (!out.dirs.includes(rule.dir)) out.dirs.push(rule.dir);
    }
    if (depth >= limits.depth) return;
    for (const entry of list) {
      if (over()) return;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || set.skip_dirs.includes(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      // A shadowed folder is the box's own: nothing in it is the project's.
      if (seen.has(childRel)) continue;
      visit(path.join(dir, entry.name), childRel, depth + 1);
    }
  };
  visit(root, "", 0);
  out.ms = now() - started;
  return out;
}

/** What a box record (record.json) says of its shadows, or null with none. */
export function shadowRecord(plan: Pick<ShadowPlan, "binds" | "env"> | null | undefined): ShadowRecord | null {
  if (!plan || (!plan.binds?.length && !Object.keys(plan.env ?? {}).length)) return null;
  return { binds: plan.binds.map((b) => ({ path: b.path, existed: Boolean(b.existed) })), env: { ...plan.env } };
}

/** The one shadows line (required.json texts.desktop.shadows; null with none active). */
export function shadowsNotice(plan: Pick<ShadowPlan, "binds" | "env" | "dirs"> | null | undefined, platform: string = process.platform, surface: "desktop" | "cli" = "desktop"): string | null {
  if (!plan || !shadowRecord(plan)) return null;
  const dirs = [...(plan.dirs ?? [])];
  const envDirs: Record<string, string> = { UV_PROJECT_ENVIRONMENT: ".venv", POETRY_VIRTUALENVS_PATH: ".venv", CARGO_TARGET_DIR: "target" };
  for (const name of Object.keys(plan.env ?? {})) if (envDirs[name] && !dirs.includes(envDirs[name]!)) dirs.push(envDirs[name]!);
  const host = hostRules(platform);
  const texts: Record<string, string> = surface === "cli" ? rules.texts.cli : rules.texts.desktop;
  return fill(texts.shadows ?? rules.texts.desktop.shadows, { dirs: dirs.slice(0, 4).join(", "), label: host?.label ?? "this computer's" });
}
