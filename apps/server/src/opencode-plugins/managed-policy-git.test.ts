import { describe, expect, test } from "bun:test";

import { rulesFromPermissionConfig, winningRule } from "../effective-permissions.js";
import { legacyExecutionPermissions } from "../managed-policy-rules.js";
import {
  DESTRUCTIVE_MARKER,
  classifyShellCommand,
  gitWorkflowPermissionRules,
  markDestructiveCommands,
  programTokens,
  splitShellCommand,
  stripDestructiveMarkers,
} from "./managed-policy-git.js";

function kinds(command: string): string[] {
  return classifyShellCommand(command).map((entry) => `${entry.kind}:${entry.family ?? "-"}`);
}

/** The text of each `command` node the engine's parser extracts: the command proper, after reserved words such as `if` or `!`. */
function commandNodes(command: string): string[] {
  return splitShellCommand(command).map((segment) => {
    const textStart = segment.start - (segment.text.length - segment.text.trimStart().length);
    return segment.text.slice(segment.commandStart - textStart).trim();
  });
}

/** The engine's evaluation: its own allow-everything default followed by the injected bash rules; last match wins. */
function engineAction(bash: Record<string, string>, command: string): string {
  const rules = [{ permission: "*", pattern: "*", action: "allow" as const }, ...rulesFromPermissionConfig({ bash })];
  const marked = markDestructiveCommands(command).command;
  return commandNodes(marked).map((node) => winningRule(rules, "bash", node)?.action ?? "ask").join(",");
}

describe("git workflow command classification", () => {
  test("read-only git and gh commands", () => {
    for (const command of [
      "git status", "git status --short", "git log --oneline -5", "git diff HEAD~1", "git show HEAD", "git fetch origin",
      "git remote -v", "git remote show origin", "git worktree list", "git branch", "git branch --list", "git branch -a",
      "git branch -vv", "git branch --show-current", "git branch --merged main", "git tag", "git tag -l 'v*'",
      "git stash list", "git config user.name", "git config --get user.email", "git config --list", "git rev-parse HEAD",
      "git clean -n", "git reflog", "git --no-pager log -3", "git -P diff", "git --version", "gh pr list", "gh pr view 12",
      "gh pr status", "gh pr checks 12", "gh issue list", "gh repo view", "gh auth status", "gh api repos/o/r/pulls",
      "gh run list", "gh --version", "/usr/bin/git status", "git -c color.ui=never log",
    ]) {
      expect({ command, kinds: kinds(command) }).toEqual({ command, kinds: [expect.stringMatching(/^read:/)] });
    }
  });

  test("write git and gh commands", () => {
    for (const command of [
      "git add -A", "git commit -m 'feat: x'", "git checkout -b feat/x", "git switch main", "git worktree add ../wt -b feat/y",
      "git worktree remove ../wt", "git push -u origin feat/x", "git pull", "git merge feat/x", "git rebase main",
      "git branch feature", "git branch -d feature", "git tag v1", "git stash", "git stash pop", "git config user.name Sam",
      "git remote add origin url", "git restore .", "git reset HEAD~1", "git clean", "gh pr create --title t --body b",
      "gh pr merge 12", "gh pr close 12", "gh repo clone o/r", "gh repo create o/r --private", "gh api -X POST repos/o/r/issues",
      "gh api repos/o/r/issues -f title=x", "gh auth login", "git frobnicate",
    ]) {
      expect({ command, kinds: kinds(command) }).toEqual({ command, kinds: [expect.stringMatching(/^write:/)] });
    }
  });

  test("destructive git, gh and shell commands", () => {
    for (const command of [
      "git push --force origin feat/x", "git push -f origin feat/x", "git push origin main --force-with-lease",
      "git push origin :old", "git push --delete origin old", "git push --mirror", "git reset --hard HEAD~1",
      "git clean -fd", "git clean -xdf", "git clean --force", "git branch -D feature", "git branch --delete --force feature",
      "git rebase -i HEAD~3", "git rebase --interactive main", "git filter-branch --all", "git stash drop", "git stash clear",
      "git reflog expire --all", "git worktree remove --force ../wt", "gh repo delete o/r --yes", "rm -rf node_modules",
      "rm -fr build", "rm -r -f build", "rm --recursive --force build", "sudo rm -rf /tmp/x", "FOO=1 git push --force",
      "git -C /tmp/repo push --force",
    ]) {
      expect({ command, kinds: kinds(command) }).toEqual({ command, kinds: [expect.stringMatching(/^destructive:/)] });
    }
    expect(kinds("rm file.txt")).toEqual(["other:rm"]);
    expect(kinds("rm -r build")).toEqual(["other:rm"]);
  });

  test("splits compound commands and substitutions, respecting quotes", () => {
    expect(kinds("cd repo && git commit -am 'push it && rm -rf all' 2>&1 | tail -1")).toEqual([
      "other:-", "write:git commit", "other:-",
    ]);
    expect(kinds("echo $(git push --force); git status")).toEqual(["other:-", "destructive:git push", "read:git status"]);
    expect(kinds('echo "$(git reset --hard)"')).toEqual(["other:-", "destructive:git reset"]);
    expect(splitShellCommand("git commit -m \"a; b\"").map((segment) => segment.tokens)).toEqual([["git", "commit", "-m", "a; b"]]);
    expect(programTokens(["FOO=1", "sudo", "-u", "root", "git", "status"])).toEqual(["git", "status"]);
    expect(programTokens(["env", "-i", "PATH=/bin", "git", "status"])).toEqual(["git", "status"]);
  });

  test("tracks git global options and commit-creating commands", () => {
    const [entry] = classifyShellCommand("git -C a -C b commit -m x");
    expect(entry).toMatchObject({ kind: "write", family: "git commit", gitDirectory: "a/b", createsCommit: true });
    expect(classifyShellCommand("git -C /repo status")[0]).toMatchObject({ kind: "read", gitDirectory: "/repo" });
    expect(classifyShellCommand("git --git-dir=/repo/.git log")[0]).toMatchObject({ kind: "read", gitDirectory: null });
    const creating = ["git commit -m x", "git merge feat", "git cherry-pick abc", "git revert abc", "git rebase main", "git am patch",
      "git stash", "git stash push -m wip", "git tag -a v1 -m msg", "git notes add -m x"];
    for (const command of creating) expect({ command, creates: classifyShellCommand(command)[0]?.createsCommit }).toEqual({ command, creates: true });
    const notCreating = ["git merge --abort", "git rebase --abort", "git cherry-pick --quit", "git stash pop", "git stash list",
      "git tag v1", "git add .", "git push", "git status"];
    for (const command of notCreating) expect({ command, creates: classifyShellCommand(command)[0]?.createsCommit }).toEqual({ command, creates: false });
  });

  test("classifies commands inside compound statements and marks them after the reserved word", () => {
    expect(kinds("if git push --force; then echo ok; fi")).toEqual(["destructive:git push", "other:-", "other:-"]);
    expect(kinds("! git push -f origin main")).toEqual(["destructive:git push"]);
    expect(kinds("for b in a b; do git push -f origin $b; done")).toEqual(["other:-", "destructive:git push", "other:-"]);
    expect(kinds("while ! git fetch; do sleep 1; done")).toEqual(["read:git fetch", "other:-", "other:-"]);
    expect(kinds("if true; then git commit -m x; else git reset --hard; fi")).toEqual(["other:-", "write:git commit", "destructive:git reset", "other:-"]);
    expect(kinds("case $x in a) git push -f;; esac")).toEqual(["other:-", "destructive:git push", "other:-"]);
    expect(kinds("{ git push -f; }")).toEqual(["destructive:git push"]);
    expect(kinds("echo ${HOME}/{a,b} && git push -f")).toEqual(["other:-", "destructive:git push"]);
    expect(kinds("time git push -f")).toEqual(["destructive:git push"]);
    expect(kinds("timeout 30 git push -f")).toEqual(["destructive:git push"]);
    expect(markDestructiveCommands("if git push --force; then echo ok; fi").command).toBe(`if ${DESTRUCTIVE_MARKER} git push --force; then echo ok; fi`);
    expect(markDestructiveCommands("! git push -f origin main").command).toBe(`! ${DESTRUCTIVE_MARKER} git push -f origin main`);
    expect(markDestructiveCommands("for b in a b; do git push -f origin $b; done").command)
      .toBe(`for b in a b; do ${DESTRUCTIVE_MARKER} git push -f origin $b; done`);
    expect(markDestructiveCommands("while ! git push -f; do sleep 1; done").command).toBe(`while ! ${DESTRUCTIVE_MARKER} git push -f; do sleep 1; done`);
    expect(markDestructiveCommands("time git push -f").command).toBe(`time ${DESTRUCTIVE_MARKER} git push -f`);
    expect(markDestructiveCommands("(git push -f)").command).toBe(`(${DESTRUCTIVE_MARKER} git push -f)`);
  });

  test("classifies commands hidden behind interpreters and marks the interpreter", () => {
    expect(kinds("bash -c 'git push --force origin main'")).toEqual(["destructive:git push"]);
    expect(kinds('sh -c "git reset --hard"')).toEqual(["destructive:git reset"]);
    expect(kinds("zsh -lc 'git status && git commit -m x'")).toEqual(["read:git status", "write:git commit"]);
    expect(kinds("eval 'git push --force'")).toEqual(["destructive:git push"]);
    expect(kinds("eval git branch -D old")).toEqual(["destructive:git branch"]);
    expect(kinds("env -S 'git push --force'")).toEqual(["destructive:git push"]);
    expect(kinds("env -S 'sudo git reset --hard'")).toEqual(["destructive:git reset"]);
    expect(kinds("sudo bash -c 'rm -rf /x'")).toEqual(["destructive:rm -rf"]);
    expect(kinds("su root -c 'git push -f'")).toEqual(["destructive:git push"]);
    expect(kinds("cat list | xargs rm -rf")).toEqual(["other:-", "destructive:rm -rf"]);
    expect(kinds("xargs -I{} -n 1 git branch -D {}")).toEqual(["destructive:git branch"]);
    expect(kinds("find . -name '*.log' -exec rm -rf {} \\;")).toEqual(["destructive:rm -rf"]);
    expect(kinds("/usr/bin/time git push -f")).toEqual(["destructive:git push"]);
    expect(kinds("bash script.sh")).toEqual(["other:-"]);
    expect(kinds("bash -c 'ls -la'")).toEqual(["other:-"]);
    expect(kinds('eval "$(ssh-agent -s)"')).toEqual(["other:-", "other:-"]);
    expect(markDestructiveCommands("bash -c 'git push --force origin main'").command).toBe(`${DESTRUCTIVE_MARKER} bash -c 'git push --force origin main'`);
    expect(markDestructiveCommands("git status && sh -c 'git status; git reset --hard'").command)
      .toBe(`git status && ${DESTRUCTIVE_MARKER} sh -c 'git status; git reset --hard'`);
    expect(markDestructiveCommands("eval 'git push --force'").command).toBe(`${DESTRUCTIVE_MARKER} eval 'git push --force'`);
    expect(markDestructiveCommands("env -S 'git push --force'").command).toBe(`${DESTRUCTIVE_MARKER} env -S 'git push --force'`);
    expect(markDestructiveCommands("cat list | xargs rm -rf").command).toBe(`cat list | ${DESTRUCTIVE_MARKER} xargs rm -rf`);
  });

  test("heredoc bodies, comments and continuation lines are data, not commands", () => {
    const script = "cat > deploy.sh <<'EOF'\ngit push --force origin main\nrm -rf build\nEOF";
    expect(kinds(script)).toEqual(["other:-"]);
    expect(markDestructiveCommands(script).command).toBe(script);
    const message = "git commit -F - <<EOF\nfeat: x\n\nrm -rf all\nEOF\ngit status";
    expect(kinds(message)).toEqual(["write:git commit", "read:git status"]);
    expect(markDestructiveCommands(message).command).toBe(message);
    const indented = "cat <<-EOF > x\n\tgit push -f\n\tEOF\ngit push -f";
    expect(markDestructiveCommands(indented).command).toBe(`cat <<-EOF > x\n\tgit push -f\n\tEOF\n${DESTRUCTIVE_MARKER} git push -f`);
    // An unquoted heredoc still expands substitutions, so those are classified.
    expect(kinds("cat <<EOF\n$(git push -f)\nEOF")).toEqual(["other:-", "destructive:git push"]);
    expect(markDestructiveCommands("cat <<EOF\n$(git push -f)\nEOF").command).toBe(`cat <<EOF\n$(${DESTRUCTIVE_MARKER} git push -f)\nEOF`);
    expect(kinds("cat <<'EOF'\n$(git push -f)\nEOF")).toEqual(["other:-"]);
    expect(kinds("git status # git push -f")).toEqual(["read:git status"]);
    expect(kinds("# rm -rf /\ngit status")).toEqual(["read:git status"]);
    expect(markDestructiveCommands("# rm -rf /\ngit status").command).toBe("# rm -rf /\ngit status");
    expect(kinds("git push \\\n  --force")).toEqual(["destructive:git push"]);
    expect(kinds("echo 'if git push -f; then :; fi'")).toEqual(["other:-"]);
  });

  test("reports the commit identity a command line supplies or writes", () => {
    const [name, email, add, commit] = classifyShellCommand('git config user.name "a b" && git config user.email a@b.c && git add -A && git commit -m x');
    expect(name).toMatchObject({ kind: "write", identityWrite: { name: true, email: false, scope: "repository" } });
    expect(email).toMatchObject({ kind: "write", identityWrite: { name: false, email: true, scope: "repository" } });
    expect(add).toMatchObject({ identityWrite: null, commitIdentity: { name: false, email: false } });
    expect(commit).toMatchObject({ createsCommit: true, identityWrite: null, commitIdentity: { name: false, email: false } });
    expect(classifyShellCommand("git config --global user.name a")[0]).toMatchObject({ identityWrite: { name: true, email: false, scope: "global" } });
    expect(classifyShellCommand("git config --local user.email e")[0]).toMatchObject({ identityWrite: { name: false, email: true, scope: "repository" } });
    expect(classifyShellCommand("git config set user.email e")[0]).toMatchObject({ kind: "write", identityWrite: { email: true } });
    expect(classifyShellCommand("git config get user.email")[0]).toMatchObject({ kind: "read", identityWrite: null });
    expect(classifyShellCommand("git config user.name")[0]).toMatchObject({ kind: "read", identityWrite: null });
    expect(classifyShellCommand("git config core.editor vim")[0]).toMatchObject({ kind: "write", identityWrite: null });
    expect(classifyShellCommand("git -C /r config user.name a")[0]).toMatchObject({ gitDirectory: "/r", identityWrite: { name: true } });
    expect(classifyShellCommand("git -c user.name=a -c user.email=b commit -m x")[0]).toMatchObject({ createsCommit: true, commitIdentity: { name: true, email: true } });
    expect(classifyShellCommand("git -c user.name=a commit -m x")[0]).toMatchObject({ commitIdentity: { name: true, email: false } });
    expect(classifyShellCommand("GIT_AUTHOR_NAME=a GIT_COMMITTER_NAME=a GIT_AUTHOR_EMAIL=e GIT_COMMITTER_EMAIL=e git commit -m x")[0])
      .toMatchObject({ commitIdentity: { name: true, email: true } });
    expect(classifyShellCommand("GIT_AUTHOR_NAME=a git commit -m x")[0]).toMatchObject({ commitIdentity: { name: false, email: false } });
    expect(classifyShellCommand("export GIT_AUTHOR_NAME=a GIT_COMMITTER_NAME=a; git commit -m x")[0])
      .toMatchObject({ kind: "other", identityWrite: { name: true, email: false, scope: "global" } });
    expect(classifyShellCommand("GIT_AUTHOR_NAME=a GIT_COMMITTER_NAME=a bash -c 'git commit -m x'")[0])
      .toMatchObject({ createsCommit: true, commitIdentity: { name: true, email: false } });
  });

  test("marks every destructive segment in place and strips markers the model wrote", () => {
    expect(markDestructiveCommands("git status && git push --force origin x")).toMatchObject({
      command: `git status && ${DESTRUCTIVE_MARKER} git push --force origin x`,
    });
    expect(markDestructiveCommands("rm -rf a; rm -rf b").command).toBe(`${DESTRUCTIVE_MARKER} rm -rf a; ${DESTRUCTIVE_MARKER} rm -rf b`);
    expect(markDestructiveCommands("echo $(git reset --hard) | cat").command).toBe(`echo $(${DESTRUCTIVE_MARKER} git reset --hard) | cat`);
    expect(markDestructiveCommands("git commit -m 'x'").command).toBe("git commit -m 'x'");
    expect(stripDestructiveMarkers(`${DESTRUCTIVE_MARKER} git status`)).toBe("git status");
    expect(markDestructiveCommands(`${DESTRUCTIVE_MARKER} git status`).command).toBe("git status");
    expect(markDestructiveCommands(`${DESTRUCTIVE_MARKER} ${DESTRUCTIVE_MARKER} git push -f`).command).toBe(`${DESTRUCTIVE_MARKER} git push -f`);
  });
});

describe("git workflow permission rules", () => {
  const bash = legacyExecutionPermissions(undefined).bash;

  test("read-only commands run, write commands ask, destructive commands ask even after a family approval", () => {
    for (const command of ["git status", "git log --oneline", "git diff", "git branch --list", "git fetch --all", "git remote -v",
      "git worktree list", "gh pr list", "gh pr view 3", "gh pr status", "gh auth status", "git --no-pager log -3", "echo hi"]) {
      expect({ command, action: engineAction(bash, command) }).toEqual({ command, action: "allow" });
    }
    for (const command of ["git add -A", "git commit -m x", "git checkout -b f", "git switch main", "git worktree add ../w -b f",
      "git worktree remove ../w", "git push origin f", "gh pr create -t t -b b", "gh pr merge 1", "gh pr close 1", "gh repo clone o/r"]) {
      expect({ command, action: engineAction(bash, command) }).toEqual({ command, action: "ask" });
    }
    for (const command of ["git push --force origin f", "git reset --hard", "git clean -fd", "git branch -D f", "git rebase -i HEAD~2",
      "git filter-branch --all", "rm -rf build", "sudo rm -rf /x", "gh repo delete o/r --yes"]) {
      expect({ command, action: engineAction(bash, command) }).toEqual({ command, action: "ask" });
    }
    // "Allow for session" on `git push origin f` makes the engine append an allow rule for the family.
    const approved = { ...bash, "git push *": "allow" };
    expect(engineAction(approved, "git push origin f")).toBe("allow");
    expect(engineAction(approved, "git push --force origin f")).toBe("ask");
    // The engine walks the commands inside compound statements; the marked ones still ask.
    expect(engineAction(approved, "if git push --force origin f; then echo ok; fi")).toBe("ask,allow,allow");
    expect(engineAction(approved, "! git push -f origin f")).toBe("ask");
    expect(engineAction(approved, "for b in a b; do git push -f origin $b; done")).toBe("allow,ask,allow");
    expect(engineAction(approved, "if git push origin f; then echo ok; fi")).toBe("allow,allow,allow");
    expect(winningRule(rulesFromPermissionConfig({ bash }), "bash", `${DESTRUCTIVE_MARKER} git push --force origin f`)?.pattern)
      .toBe(`${DESTRUCTIVE_MARKER} *`);
  });

  test("interpreter wrappers ask once per family and destructive commands behind them always ask", () => {
    for (const command of ["bash -c 'git commit -m x'", "sh -c 'git status'", "/bin/bash -lc 'git push origin f'", "eval 'git commit -m x'",
      "env -S 'git commit -m x'", "su root -c 'git status'"]) {
      expect({ command, action: engineAction(bash, command) }).toEqual({ command, action: "ask" });
    }
    for (const command of ["bash -c 'git push --force origin f'", "sh -c 'git reset --hard'", "eval 'git push --force'", "env -S 'git push --force'",
      "cat list | xargs rm -rf", "sudo bash -c 'rm -rf /x'"]) {
      expect({ command, asks: /(^|,)ask$/.test(engineAction(bash, command)) }).toEqual({ command, asks: true });
    }
    const approved = { ...bash, "bash *": "allow", "eval *": "allow", "xargs *": "allow" };
    expect(engineAction(approved, "bash -c 'git commit -m x'")).toBe("allow");
    expect(engineAction(approved, "bash -c 'git push --force origin f'")).toBe("ask");
    expect(engineAction(approved, "eval 'git push --force'")).toBe("ask");
    expect(engineAction(approved, "cat list | xargs rm -rf")).toBe("allow,ask");
    expect(engineAction(bash, "bash script.sh")).toBe("allow");
    expect(engineAction(bash, "cat > deploy.sh <<'EOF'\ngit push --force origin main\nEOF")).toBe("allow");
  });

  test("a stricter user ruleset ahead of ours does not turn read-only commands into prompts", () => {
    const user = { "*": "ask" as const };
    expect(engineAction({ ...user, ...bash }, "git status")).toBe("allow");
    expect(engineAction({ ...user, ...bash }, "git commit -m x")).toBe("ask");
    expect(engineAction({ ...user, ...bash }, "echo hi")).toBe("ask");
  });

  test("organization rules come last and win over workflow allows", () => {
    const denied = legacyExecutionPermissions({ commands: "deny", blockedCommands: [], blockBrowserUploads: false }).bash;
    expect(Object.keys(denied).at(-1)).toBe("*");
    for (const command of ["git status", "git commit -m x", "echo hi"]) expect(engineAction(denied, command)).toBe("deny");

    const blocked = legacyExecutionPermissions({ commands: "allow", blockedCommands: ["git push*", "git *"], blockBrowserUploads: false }).bash;
    expect(Object.keys(blocked).slice(-2)).toEqual(["git push*", "git *"]);
    expect(engineAction(blocked, "git status")).toBe("deny");
    expect(engineAction(blocked, "git push origin f")).toBe("deny");
    expect(engineAction(blocked, "gh pr list")).toBe("allow");
  });

  test("rule table shape", () => {
    const rules = gitWorkflowPermissionRules();
    expect(Object.entries(rules).slice(0, 3)).toEqual([["git *", "ask"], ["gh *", "ask"], ["sudo *", "ask"]]);
    expect(Object.keys(rules).at(-1)).toBe(`${DESTRUCTIVE_MARKER} *`);
    expect(Object.values(rules).every((action) => action === "allow" || action === "ask")).toBe(true);
  });
});
