import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const savedEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function start() {
  const root = await mkdtemp(join(tmpdir(), "omnirush-skill-bundle-e2e-"));
  roots.push(root);
  await mkdir(join(root, ".git"), { recursive: true });
  // Keep global skills (~/.config/opencode/skills, ~/.claude/skills) out of collision checks.
  process.env.HOME = join(root, "home");
  process.env.XDG_CONFIG_HOME = join(root, "home", ".config");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}/workspace/ws_1`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() as Record<string, any> };
  };
  return { root, call };
}

const b64 = (text: string) => Buffer.from(text).toString("base64");
const SKILL = "---\nname: greeter\ndescription: Greets people with the helper script\n---\n\nRun `scripts/greet.sh <name>` from this skill's base directory.\n";

describe("skill folder upload routes", () => {
  test("preview, install, conflict + replace/rename, list and edit helper files", async () => {
    const { root, call } = await start();
    const files = [
      { path: "greeter/SKILL.md", contentBase64: b64(SKILL) },
      { path: "greeter/scripts/greet.sh", contentBase64: b64("#!/bin/sh\necho \"hello $1\"\n") },
      { path: "greeter/references/tone.md", contentBase64: b64("Be warm.\n") },
      { path: "greeter/.DS_Store", contentBase64: b64("junk") },
    ];

    const preview = await call("POST", "/skills/bundle/preview", { files });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({
      name: "greeter",
      strippedRoot: "greeter",
      skipped: ["greeter/.DS_Store"],
      conflict: null,
    });
    expect(preview.json.files.map((f: { path: string }) => f.path)).toEqual(["SKILL.md", "references/tone.md", "scripts/greet.sh"]);
    // A preview writes nothing.
    await expect(stat(join(root, ".opencode", "skills", "greeter"))).rejects.toThrow();

    const installed = await call("POST", "/skills/bundle", { files });
    expect(installed.status).toBe(200);
    expect(installed.json.action).toBe("added");
    const dir = join(root, ".opencode", "skills", "greeter");
    expect((await stat(join(dir, "scripts", "greet.sh"))).mode & 0o100).toBe(0o100);

    const listed = await call("GET", "/skills");
    expect(listed.json.items.map((s: { name: string }) => s.name)).toEqual(["greeter"]);

    // Same name again: preview reports it, install refuses without "replace".
    const again = await call("POST", "/skills/bundle/preview", { files });
    expect(again.json.conflict).toMatchObject({ name: "greeter", scope: "project", replaceable: true });
    expect((await call("POST", "/skills/bundle", { files })).status).toBe(409);
    expect((await call("POST", "/skills/bundle", { files, onConflict: "replace" })).json.action).toBe("updated");

    // Rename installs a second copy with a rewritten frontmatter name.
    const renamed = await call("POST", "/skills/bundle", { files, name: "greeter-copy" });
    expect(renamed.status).toBe(200);
    expect(await readFile(join(root, ".opencode", "skills", "greeter-copy", "SKILL.md"), "utf8")).toContain("name: greeter-copy");

    const tree = await call("GET", "/skills/greeter/files");
    expect(tree.status).toBe(200);
    expect(tree.json.files.map((f: { path: string }) => f.path)).toEqual(["SKILL.md", "references/tone.md", "scripts/greet.sh"]);

    const edited = await call("POST", "/skills/greeter/files", {
      add: [{ path: "scripts/farewell.py", contentBase64: b64("print('bye')\n") }],
      remove: ["references/tone.md"],
    });
    expect(edited.status).toBe(200);
    expect(edited.json.files.map((f: { path: string }) => f.path)).toEqual(["SKILL.md", "scripts/farewell.py", "scripts/greet.sh"]);

    // Editing SKILL.md through the existing upsert keeps the helper files.
    const upsert = await call("POST", "/skills", { name: "greeter", content: SKILL.replace("Greets people", "Greets everyone") });
    expect(upsert.status).toBe(200);
    expect((await call("GET", "/skills/greeter/files")).json.files).toHaveLength(3);
  });

  test("refuses unsafe uploads with readable errors", async () => {
    const { call } = await start();
    const skill = { path: "SKILL.md", contentBase64: b64(SKILL) };
    const cases: Array<[unknown[], number, string]> = [
      [[skill, { path: "../evil.sh", contentBase64: b64("x") }], 422, "invalid_skill_path"],
      [[skill, { path: "/abs.sh", contentBase64: b64("x") }], 422, "invalid_skill_path"],
      [[skill, { path: ".env", contentBase64: b64("TOKEN=1") }], 422, "skill_bundle_credentials"],
      [[{ path: "notes.md", contentBase64: b64("x") }], 422, "skill_md_missing"],
      [[{ path: "SKILL.md", contentBase64: b64("no frontmatter") }], 422, "invalid_skill_frontmatter"],
    ];
    for (const [files, status, code] of cases) {
      const response = await call("POST", "/skills/bundle", { files });
      expect({ status: response.status, code: response.json.code }).toEqual({ status, code });
    }
    const credential = await call("POST", "/skills/bundle/preview", { files: [skill, { path: "keys/id_ed25519", contentBase64: b64("x") }] });
    expect(credential.json.details).toEqual({ paths: ["keys/id_ed25519"] });
    expect((await call("GET", "/skills/nope/files")).status).toBe(404);
  });

  test("refuses an oversized body before buffering it", async () => {
    const { call } = await start();
    const huge = "A".repeat(40 * 1024 * 1024);
    const response = await call("POST", "/skills/bundle/preview", { files: [{ path: "SKILL.md", contentBase64: huge }] });
    expect(response.status).toBe(413);
  });
});
