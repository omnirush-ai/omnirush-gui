import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import managedPolicy from "./managed-policy.js";
import managedPolicyNext from "./managed-policy-next.js";
import { DESTRUCTIVE_MARKER } from "./managed-policy-git.js";
import { annotateShellOutput, prepareShellCommand, readGitIdentity } from "./managed-policy-client.js";

type EvaluateCall = { action: string; input: Record<string, unknown> };

const roots: string[] = [];
const stops: Array<() => void> = [];
const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined) {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** `git config --get` that answers "" for an unset key instead of exiting 1. */
function gitGet(cwd: string, ...args: string[]): string {
  try {
    return git(cwd, "config", ...args);
  } catch {
    return "";
  }
}

async function temporaryRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "omnirush-managed-policy-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}

/**
 * Stand-in for the server's /managed-policy/evaluate route: records calls and,
 * for git_identity, behaves like a desktop with (or without) an account.
 */
function policyServer(options: { account: { name: string; email: string } | null }) {
  const calls: EvaluateCall[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/managed-policy/evaluate" || request.headers.get("authorization") !== "Bearer policy-token") {
        return Response.json({ code: "unauthorized", message: "unauthorized" }, { status: 401 });
      }
      const body = await request.json() as EvaluateCall;
      calls.push(body);
      if (body.action === "git_identity") {
        const directory = String(body.input.directory);
        if (!options.account) return Response.json({ code: "git_identity_required", message: "Git identity is not configured for this repository; ask the user for a name and email and run git config user.name / user.email (never --global)." }, { status: 412 });
        if (!gitGet(directory, "--get", "user.name")) git(directory, "config", "--local", "user.name", options.account.name);
        if (!gitGet(directory, "--get", "user.email")) git(directory, "config", "--local", "user.email", options.account.email);
      }
      return Response.json({ allowed: true });
    },
  });
  stops.push(() => server.stop(true));
  setEnv("OMNIRUSH_SERVER_URL", `http://127.0.0.1:${server.port}`);
  setEnv("OMNIRUSH_POLICY_TOKEN", "policy-token");
  return { calls };
}

beforeEach(async () => {
  // Keep the developer's own ~/.gitconfig identity out of the repositories under test.
  const root = await mkdtemp(path.join(tmpdir(), "omnirush-gitconfig-"));
  roots.push(root);
  await writeFile(path.join(root, "gitconfig"), "", "utf8");
  setEnv("GIT_CONFIG_GLOBAL", path.join(root, "gitconfig"));
  setEnv("GIT_CONFIG_NOSYSTEM", "1");
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) setEnv(key, undefined);
});

afterEach(async () => {
  while (stops.length) stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

describe("managed-policy engine plugin: git workflows", () => {
  test("evaluates the organization policy on the original command, then marks destructive segments", async () => {
    const { calls } = policyServer({ account: null });
    const hooks = await managedPolicy({ directory: await temporaryRepository() });
    const args: Record<string, unknown> = { command: "git status && git push --force origin main" };
    await hooks["tool.execute.before"]({ tool: "bash", callID: "call_1", sessionID: "ses_1" }, { args });
    expect(calls).toEqual([{ action: "shell", input: { command: "git status && git push --force origin main" } }]);
    expect(args.command).toBe(`git status && ${DESTRUCTIVE_MARKER} git push --force origin main`);
  });

  test("defaults the commit identity from the omnirush.ai account for that repository and says so in the tool output", async () => {
    const { calls } = policyServer({ account: { name: "Sam Example", email: "sam@example.com" } });
    const repo = await temporaryRepository();
    const hooks = await managedPolicy({ directory: repo });
    const args: Record<string, unknown> = { command: "git add -A && git commit -m 'feat: hello'" };
    await hooks["tool.execute.before"]({ tool: "bash", callID: "call_2", sessionID: "ses_1" }, { args });
    expect(calls.map((call) => call.action)).toEqual(["shell", "git_identity"]);
    expect(calls[1]?.input).toEqual({ directory: repo });
    expect(git(repo, "config", "--local", "--get", "user.name")).toBe("Sam Example");
    expect(git(repo, "config", "--local", "--get", "user.email")).toBe("sam@example.com");
    expect(gitGet(repo, "--global", "--get", "user.name")).toBe("");
    const output = { title: "git commit", output: "[main abc] feat: hello", metadata: {} };
    await hooks["tool.execute.after"]({ tool: "bash", callID: "call_2", sessionID: "ses_1", args }, output);
    expect(output.output).toContain("[omnirush.ai] omnirush.ai set the commit identity for");
    expect(output.output).toContain("Sam Example <sam@example.com>");
    expect(output.output).toContain("never global");
    // The note is delivered once.
    expect(annotateShellOutput("call_2", "again")).toBe("again");
  });

  test("respects an identity the repository already has and a workdir argument", async () => {
    const { calls } = policyServer({ account: { name: "Account Name", email: "account@example.com" } });
    const workspace = await temporaryRepository();
    const nested = await temporaryRepository();
    git(nested, "config", "--local", "user.name", "Repo Owner");
    git(nested, "config", "--local", "user.email", "owner@example.com");
    const hooks = await managedPolicy({ directory: workspace });
    await hooks["tool.execute.before"]({ tool: "bash", callID: "call_3", sessionID: "ses_1" }, { args: { command: "git commit -m x", workdir: nested } });
    expect(calls.map((call) => call.action)).toEqual(["shell"]);
    expect(git(nested, "config", "--local", "--get", "user.name")).toBe("Repo Owner");
  });

  test("refuses a commit with a clear message when no account can supply the identity", async () => {
    policyServer({ account: null });
    const repo = await temporaryRepository();
    const hooks = await managedPolicy({ directory: repo });
    await expect(hooks["tool.execute.before"]({ tool: "bash", callID: "call_4", sessionID: "ses_1" }, { args: { command: "git commit -m x" } }))
      .rejects.toThrow(/Git identity is not configured .*git config user\.name/);
    expect(await readGitIdentity(repo)).toEqual({ repository: true, name: null, email: null });
  });

  test("accepts the recovery the refusal asks for: identity configured earlier in the same command line", async () => {
    const { calls } = policyServer({ account: null });
    const repo = await temporaryRepository();
    const hooks = await managedPolicy({ directory: repo });
    const args: Record<string, unknown> = {
      command: 'git config user.name "omnirush e2e" && git config user.email e2e@example.com && git add -A && git commit -m "feat: x"',
      workdir: ".",
    };
    await hooks["tool.execute.before"]({ tool: "bash", callID: "call_10", sessionID: "ses_1" }, { args });
    expect(calls.map((call) => call.action)).toEqual(["shell"]);
    expect(args.command).toBe('git config user.name "omnirush e2e" && git config user.email e2e@example.com && git add -A && git commit -m "feat: x"');
    // Inline config and an exported author/committer pair count as well.
    for (const command of [
      "git -c user.name=a -c user.email=a@example.com commit -m x",
      "GIT_AUTHOR_NAME=a GIT_COMMITTER_NAME=a GIT_AUTHOR_EMAIL=e GIT_COMMITTER_EMAIL=e git commit -m x",
      "export GIT_AUTHOR_NAME=a GIT_COMMITTER_NAME=a GIT_AUTHOR_EMAIL=e GIT_COMMITTER_EMAIL=e; git commit -m x",
      "git config --global user.name a && git config --global user.email e && git commit -m x",
    ]) {
      await hooks["tool.execute.before"]({ tool: "bash", callID: "call_11", sessionID: "ses_1" }, { args: { command } });
    }
    expect(calls.map((call) => call.action)).toEqual(["shell", "shell", "shell", "shell", "shell"]);
    // Half an identity, one written after the commit, or one written to another repository is still refused.
    const other = await temporaryRepository();
    for (const command of [
      'git config user.name "only name" && git commit -m x',
      "git commit -m x && git config user.name a && git config user.email e",
      `git config user.name a && git config user.email e && git -C ${other} commit -m x`,
    ]) {
      await expect(hooks["tool.execute.before"]({ tool: "bash", callID: "call_12", sessionID: "ses_1" }, { args: { command } }))
        .rejects.toThrow(/Git identity is not configured/);
    }
    expect(calls.filter((call) => call.action === "git_identity")).toHaveLength(3);
    expect(await readGitIdentity(repo)).toEqual({ repository: true, name: null, email: null });
  });

  test("marks destructive commands inside compound statements and interpreters, never inside heredocs", async () => {
    policyServer({ account: null });
    const hooks = await managedPolicy({ directory: await temporaryRepository() });
    const cases: Array<[string, string]> = [
      ["if git push --force origin main; then echo ok; fi", `if ${DESTRUCTIVE_MARKER} git push --force origin main; then echo ok; fi`],
      ["! git push -f origin main", `! ${DESTRUCTIVE_MARKER} git push -f origin main`],
      ["for b in a b; do git push -f origin $b; done", `for b in a b; do ${DESTRUCTIVE_MARKER} git push -f origin $b; done`],
      ["bash -c 'git push --force origin main'", `${DESTRUCTIVE_MARKER} bash -c 'git push --force origin main'`],
      ['sh -c "git reset --hard"', `${DESTRUCTIVE_MARKER} sh -c "git reset --hard"`],
      ["eval 'git push --force'", `${DESTRUCTIVE_MARKER} eval 'git push --force'`],
      ["env -S 'git push --force'", `${DESTRUCTIVE_MARKER} env -S 'git push --force'`],
      ["cat > deploy.sh <<'EOF'\ngit push --force origin main\nEOF", "cat > deploy.sh <<'EOF'\ngit push --force origin main\nEOF"],
      ["git commit -F - <<EOF\nfeat: x\n\nrm -rf all\nEOF", "git commit -F - <<EOF\nfeat: x\n\nrm -rf all\nEOF"],
    ];
    for (const [command, expected] of cases) {
      const args: Record<string, unknown> = { command };
      await hooks["tool.execute.before"]({ tool: "bash", callID: "call_13", sessionID: "ses_1" }, { args }).catch(() => undefined);
      expect({ command, rewritten: args.command }).toEqual({ command, rewritten: expected });
    }
  });

  test("skips the identity check outside a repository and for non-committing commands", async () => {
    const { calls } = policyServer({ account: null });
    const root = await mkdtemp(path.join(tmpdir(), "omnirush-not-a-repo-"));
    roots.push(root);
    const hooks = await managedPolicy({ directory: root });
    await hooks["tool.execute.before"]({ tool: "bash", callID: "call_5", sessionID: "ses_1" }, { args: { command: "git commit -m x" } });
    await hooks["tool.execute.before"]({ tool: "bash", callID: "call_6", sessionID: "ses_1" }, { args: { command: "git status" } });
    expect(calls.map((call) => call.action)).toEqual(["shell", "shell"]);
  });

  test("git -C targets the repository the command names", async () => {
    const { calls } = policyServer({ account: { name: "Sam Example", email: "sam@example.com" } });
    const workspace = await temporaryRepository();
    const other = await temporaryRepository();
    const hooks = await managedPolicy({ directory: workspace });
    await hooks["tool.execute.before"]({ tool: "bash", callID: "call_7", sessionID: "ses_1" }, { args: { command: `git -C ${other} commit -m x` } });
    expect(calls[1]).toEqual({ action: "git_identity", input: { directory: other } });
    expect(git(other, "config", "--local", "--get", "user.email")).toBe("sam@example.com");
    expect(gitGet(workspace, "--local", "--get", "user.email")).toBe("");
  });

  test("hands the bash tool a PATH with the well-known tool directories", async () => {
    policyServer({ account: null });
    const hooks = await managedPolicy({ directory: await temporaryRepository() });
    const output = { env: {} as Record<string, string> };
    await hooks["shell.env"]({ cwd: "/" }, output);
    const entries = output.env.PATH?.split(path.delimiter) ?? [];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) expect(entries).toContain(entry);
    if (process.platform === "darwin") expect(entries).toContain("/usr/bin");
    expect(process.env.PATH?.split(path.delimiter)).toEqual(entries);
  });

  test("the next-engine plugin applies the same rules through its structural hooks", async () => {
    const { calls } = policyServer({ account: { name: "Sam Example", email: "sam@example.com" } });
    const repo = await temporaryRepository();
    const hooks: Record<string, (event: never) => Promise<void>> = {};
    await managedPolicyNext.setup({
      directory: repo,
      tool: { hook: async (name, callback) => { hooks[`tool.${name}`] = callback as never; } },
      shell: { hook: async (name, callback) => { hooks[`shell.${name}`] = callback as never; } },
      session: { hook: async (name, callback) => { hooks[`session.${name}`] = callback as never; } },
    });
    const input: Record<string, unknown> = { command: "git commit -m x && rm -rf build" };
    await hooks["tool.execute.before"]({ tool: "bash", input, callID: "call_8" } as never);
    expect(input.command).toBe(`git commit -m x && ${DESTRUCTIVE_MARKER} rm -rf build`);
    expect(calls.map((call) => call.action)).toEqual(["shell", "git_identity"]);
    expect(git(repo, "config", "--local", "--get", "user.name")).toBe("Sam Example");
  });

  test("prepareShellCommand accepts injected identity readers for other engines", async () => {
    const seen: string[] = [];
    const input: Record<string, unknown> = { command: "git commit -m x" };
    await prepareShellCommand(input, { directory: "/workspace", callID: "call_9" }, {
      readIdentity: async () => ({ repository: true, name: null, email: null }),
      ensureIdentity: async (directory) => { seen.push(directory); },
      env: {},
    }).then(() => { throw new Error("expected a refusal"); }, (error: Error) => {
      expect(error.message).toContain("Git identity is not configured");
    });
    expect(seen).toEqual(["/workspace"]);
  });
});
