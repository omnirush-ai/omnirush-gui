import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

import { gitMarkerDetector, gitParentCandidates, gitParentDetector, isArchivableProject, type ProjectMarkerDetector } from "./detect.js";
import { cleanupTempDirs, tempDir } from "./test-helpers.js";

afterEach(cleanupTempDirs);

describe("project gate", () => {
  test("a folder with a .git directory is archivable", async () => {
    const root = await tempDir("gate-dir");
    await mkdir(join(root, ".git"));
    expect(await isArchivableProject(root)).toEqual({ archivable: true, reason: "git_dir", marker: ".git" });
  });

  test("a folder with a .git gitfile (worktree or submodule) is archivable, even when its target is missing", async () => {
    const root = await tempDir("gate-file");
    await writeFile(join(root, ".git"), "gitdir: /nowhere/.git/worktrees/feature\n");
    expect(await isArchivableProject(root)).toEqual({ archivable: true, reason: "git_file", marker: ".git" });
  });

  test("a folder without .git is not archivable", async () => {
    const root = await tempDir("gate-none");
    await writeFile(join(root, "package.json"), "{}");
    expect(await isArchivableProject(root)).toEqual({ archivable: false, reason: "no_marker", marker: null });
  });

  test("a .git file that is not a gitfile, or too large, is gitfile_invalid", async () => {
    const root = await tempDir("gate-invalid");
    await writeFile(join(root, ".git"), "not a gitfile\n");
    expect(await isArchivableProject(root)).toEqual({ archivable: false, reason: "gitfile_invalid", marker: null });
    await writeFile(join(root, ".git"), `gitdir: ${"x".repeat(5000)}\n`);
    expect((await isArchivableProject(root)).reason).toBe("gitfile_invalid");
  });

  test("a .git symlink is no marker", async () => {
    const root = await tempDir("gate-link");
    const real = await tempDir("gate-link-target");
    await mkdir(join(real, ".git"));
    await symlink(join(real, ".git"), join(root, ".git"));
    expect(await gitMarkerDetector(root)).toBeNull();
    expect((await isArchivableProject(root)).reason).toBe("no_marker");
  });

  test("the home directory, filesystem roots and the app's own directories are refused before any detector runs", async () => {
    let calls = 0;
    const counting: ProjectMarkerDetector = async () => {
      calls += 1;
      return { archivable: true, reason: "git_dir", marker: ".git" };
    };
    expect(await isArchivableProject(homedir(), [counting])).toEqual({ archivable: false, reason: "root_too_broad", marker: null });
    expect((await isArchivableProject("/", [counting])).reason).toBe("root_too_broad");
    const fakeHome = await tempDir("gate-home");
    await mkdir(join(fakeHome, ".git"));
    expect((await isArchivableProject(fakeHome, [gitMarkerDetector], { homeDir: fakeHome })).reason).toBe("root_too_broad");
    const state = await tempDir("gate-state");
    await mkdir(join(state, "inner/.git"), { recursive: true });
    expect((await isArchivableProject(join(state, "inner"), [counting], { appDirs: [state] })).reason).toBe("root_too_broad");
    expect(calls).toBe(0);
  });

  test("a root that is not an absolute path to an existing directory is root_not_directory", async () => {
    const root = await tempDir("gate-notdir");
    await writeFile(join(root, "file"), "x");
    await symlink(root, join(root, "link"));
    expect((await isArchivableProject(join(root, "file"))).reason).toBe("root_not_directory");
    expect((await isArchivableProject(join(root, "missing"))).reason).toBe("root_not_directory");
    expect((await isArchivableProject("relative/path")).reason).toBe("root_not_directory");
    expect((await isArchivableProject(join(root, "link"))).reason).toBe("root_not_directory");
  });

  test("detectors plug in: the first archivable result wins, else the first non-null one", async () => {
    const root = await tempDir("gate-plugins");
    const blend: ProjectMarkerDetector = async () => ({ archivable: true, reason: "blend_file", marker: "*.blend" });
    const invalid: ProjectMarkerDetector = async () => ({ archivable: false, reason: "gitfile_invalid", marker: null });
    const broken: ProjectMarkerDetector = async () => {
      throw new Error("detectors must not throw, but the gate survives it");
    };
    expect(await isArchivableProject(root, [broken, invalid, blend])).toEqual({ archivable: true, reason: "blend_file", marker: "*.blend" });
    expect((await isArchivableProject(root, [invalid, gitMarkerDetector])).reason).toBe("gitfile_invalid");
  });

  // Temp folders live under /private or /var on macOS, which the walk never enters; systemDirs: [] lifts that here.
  const anyDir = { systemDirs: [] as string[] };

  /** A `.git` folder git accepts as a parent repository: one with HEAD. */
  async function gitDirWithHead(dir: string): Promise<void> {
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
  }

  test("a folder inside a repository is archivable as git_parent, from a .git directory or gitfile at the nearest parent", async () => {
    const repo = await tempDir("gate-parent");
    await gitDirWithHead(repo);
    await mkdir(join(repo, "packages/app/src"), { recursive: true });
    const git_parent = { archivable: true, reason: "git_parent", marker: ".git" };
    expect(await isArchivableProject(join(repo, "packages/app"), undefined, anyDir)).toEqual(git_parent);
    expect(await isArchivableProject(join(repo, "packages/app/src"), undefined, anyDir)).toEqual(git_parent);
    // A worktree or submodule nested in the repo: its gitfile is the nearest .git.
    await writeFile(join(repo, "packages/.git"), "gitdir: ../.git/modules/packages\n");
    expect(await isArchivableProject(join(repo, "packages/app"), undefined, anyDir)).toEqual(git_parent);
    // The nearest .git decides: an invalid gitfile or a symlink there qualifies nothing, even with a repo above.
    await writeFile(join(repo, "packages/.git"), "not a gitfile\n");
    expect((await isArchivableProject(join(repo, "packages/app"), undefined, anyDir)).reason).toBe("no_marker");
    await rm(join(repo, "packages/.git"));
    await symlink(join(repo, ".git"), join(repo, "packages/.git"));
    expect((await isArchivableProject(join(repo, "packages/app"), undefined, anyDir)).reason).toBe("no_marker");
    // So does a .git folder without HEAD, which git would skip on its way up to the repository above.
    await rm(join(repo, "packages/.git"));
    await mkdir(join(repo, "packages/.git"));
    expect((await isArchivableProject(join(repo, "packages/app"), undefined, anyDir)).reason).toBe("no_marker");
    await rm(join(repo, "packages/.git"), { recursive: true });
    // A root inside the repository's own .git never qualifies: that would upload its history.
    await mkdir(join(repo, ".git/hooks"));
    expect((await isArchivableProject(join(repo, ".git/hooks"), undefined, anyDir)).reason).toBe("no_marker");
    // The SessionArchiver default runs both detectors; the root marker alone does not look up.
    expect((await isArchivableProject(join(repo, "packages/app"), [gitMarkerDetector], anyDir)).reason).toBe("no_marker");
  });

  test("a .git in the root itself is still preferred, and an invalid one there is not overridden by a parent", async () => {
    const repo = await tempDir("gate-prefer");
    await gitDirWithHead(repo);
    await mkdir(join(repo, "vendor/lib/.git"), { recursive: true });
    await mkdir(join(repo, "tools/cli"), { recursive: true });
    expect(await isArchivableProject(join(repo, "vendor/lib"), undefined, anyDir)).toEqual({ archivable: true, reason: "git_dir", marker: ".git" });
    await writeFile(join(repo, "tools/cli/.git"), "not a gitfile\n");
    expect((await isArchivableProject(join(repo, "tools/cli"), undefined, anyDir)).reason).toBe("gitfile_invalid");
    expect(await gitParentDetector(join(repo, "tools/cli"), anyDir)).toBeNull();
  });

  test("a dotfiles repository at the home directory, or anything above it, does not qualify a folder in home", async () => {
    const above = await tempDir("gate-dotfiles");
    await mkdir(join(above, ".git"));
    const home = join(above, "home");
    await mkdir(join(home, ".git"), { recursive: true });
    await mkdir(join(home, "code/app"), { recursive: true });
    expect((await isArchivableProject(join(home, "code/app"), undefined, { ...anyDir, homeDir: home })).reason).toBe("no_marker");
    await rm(join(home, ".git"), { recursive: true });
    expect((await isArchivableProject(join(home, "code/app"), undefined, { ...anyDir, homeDir: home })).reason).toBe("no_marker");
    // A real project inside home still qualifies.
    await gitDirWithHead(join(home, "code"));
    expect((await isArchivableProject(join(home, "code/app"), undefined, { ...anyDir, homeDir: home })).reason).toBe("git_parent");
  });

  test("a repository in a system or app directory does not qualify a folder inside it", async () => {
    const repo = await tempDir("gate-system");
    await gitDirWithHead(repo);
    await mkdir(join(repo, "Contents/Resources"), { recursive: true });
    expect((await isArchivableProject(join(repo, "Contents/Resources"), undefined, { systemDirs: [repo] })).reason).toBe("no_marker");
    expect((await isArchivableProject(join(repo, "Contents/Resources"), undefined, { systemDirs: [join(repo, "..")] })).reason).toBe("no_marker");
    // The walk stops at the first guarded folder, even with a repository above it.
    expect((await isArchivableProject(join(repo, "Contents/Resources"), undefined, { systemDirs: [join(repo, "Contents")] })).reason).toBe("no_marker");
    expect((await isArchivableProject(join(repo, "Contents/Resources"), undefined, { systemDirs: [join(repo, "Other")] })).reason).toBe("git_parent");
  });

  test("the parent walk, posix: stops at home, a filesystem or volume root, and system and app directories", () => {
    const home = ["/Users/sam"];
    expect(gitParentCandidates("/Users/sam/proj/packages/app", home, posix)).toEqual(["/Users/sam/proj/packages", "/Users/sam/proj"]);
    expect(gitParentCandidates("/Users/sam/app", home, posix)).toEqual([]);
    expect(gitParentCandidates("/users/SAM/proj/app", home, posix)).toEqual(["/users/SAM/proj"]);
    expect(gitParentCandidates("/Users/other/proj/app", home, posix)).toEqual(["/Users/other/proj"]);
    expect(gitParentCandidates("/home/sam/proj/app", ["/home/sam"], posix)).toEqual(["/home/sam/proj"]);
    expect(gitParentCandidates("/srv/code/proj/app", home, posix)).toEqual(["/srv/code/proj", "/srv/code", "/srv"]);
    expect(gitParentCandidates("/proj", home, posix)).toEqual([]);
    expect(gitParentCandidates("/Volumes/Backup/proj/app", home, posix)).toEqual(["/Volumes/Backup/proj"]);
    expect(gitParentCandidates("/Volumes/Backup/app", home, posix)).toEqual([]);
    // Homes on another volume: the rule is relative to the volume root, not to /.
    expect(gitParentCandidates("/Volumes/Ext/Users/other/code/app", home, posix)).toEqual(["/Volumes/Ext/Users/other/code"]);
    expect(gitParentCandidates("/Volumes/Ext/home/sam/app", home, posix)).toEqual([]);
    expect(gitParentCandidates("/Volumes/Ext/srv/proj/app", home, posix)).toEqual(["/Volumes/Ext/srv/proj", "/Volumes/Ext/srv"]);
    for (const guarded of ["/System/Volumes/Data/x/app", "/Library/Developer/x/app", "/Applications/Foo.app/Contents/Resources/app", "/usr/local/proj/app", "/private/tmp/proj/app", "/private/var/folders/xy/T/proj/app", "/var/www/site/app", "/etc/nixos/app", "/opt/homebrew/Library/Taps", "/USR/local/x/app"]) {
      expect(gitParentCandidates(guarded, home, posix)).toEqual([]);
    }
  });

  test("the parent walk, path.win32: stops at home, a drive or UNC share root, and Windows, Program Files and ProgramData", () => {
    const home = ["C:\\Users\\sam"];
    expect(gitParentCandidates("C:\\src\\proj\\packages\\app", home, win32)).toEqual(["C:\\src\\proj\\packages", "C:\\src\\proj", "C:\\src"]);
    expect(gitParentCandidates("C:\\Users\\sam\\proj\\app", home, win32)).toEqual(["C:\\Users\\sam\\proj"]);
    expect(gitParentCandidates("c:\\users\\SAM\\app", home, win32)).toEqual([]);
    expect(gitParentCandidates("C:\\Users\\other\\proj\\app", home, win32)).toEqual(["C:\\Users\\other\\proj"]);
    expect(gitParentCandidates("D:\\proj\\app", home, win32)).toEqual(["D:\\proj"]);
    expect(gitParentCandidates("D:\\app", home, win32)).toEqual([]);
    expect(gitParentCandidates("\\\\server\\share\\proj\\app", home, win32)).toEqual(["\\\\server\\share\\proj"]);
    expect(gitParentCandidates("\\\\server\\share\\app", home, win32)).toEqual([]);
    expect(gitParentCandidates("\\\\?\\UNC\\server\\share\\app", home, win32)).toEqual([]);
    expect(gitParentCandidates("\\\\?\\C:\\src\\proj\\app", home, win32)).toEqual(["C:\\src\\proj", "C:\\src"]);
    expect(gitParentCandidates("D:\\Users\\other\\proj\\app", home, win32)).toEqual(["D:\\Users\\other\\proj"]);
    // A WSL distro is a UNC share: its homes and Linux system folders are guarded against the share root.
    expect(gitParentCandidates("\\\\wsl$\\Ubuntu\\home\\sam\\code\\app", home, win32)).toEqual(["\\\\wsl$\\Ubuntu\\home\\sam\\code"]);
    expect(gitParentCandidates("\\\\wsl.localhost\\Ubuntu\\home\\sam\\code\\app", home, win32)).toEqual(["\\\\wsl.localhost\\Ubuntu\\home\\sam\\code"]);
    expect(gitParentCandidates("//wsl$/Ubuntu/home/sam/code/app", home, win32)).toEqual(["//wsl$/Ubuntu/home/sam/code"]);
    expect(gitParentCandidates("\\\\wsl$\\Ubuntu\\srv\\proj\\app", home, win32)).toEqual(["\\\\wsl$\\Ubuntu\\srv\\proj", "\\\\wsl$\\Ubuntu\\srv"]);
    // A share of home folders.
    expect(gitParentCandidates("\\\\nas\\homes\\sam\\proj\\app", home, win32)).toEqual(["\\\\nas\\homes\\sam\\proj"]);
    expect(gitParentCandidates("\\\\server\\Users\\sam\\app", home, win32)).toEqual([]);
    for (const guarded of ["C:\\Windows\\System32\\x\\app", "c:\\windows\\x\\app", "C:\\Program Files\\App\\resources\\app", "D:\\Program Files (x86)\\App\\x", "C:\\ProgramData\\chocolatey\\lib\\x", "\\\\server\\share\\Windows\\x\\app", "\\\\wsl.localhost\\Ubuntu\\etc\\x", "\\\\wsl.localhost\\Ubuntu\\etc\\nixos\\app", "\\\\wsl$\\Ubuntu\\usr\\local\\x\\app", "\\\\wsl$\\Ubuntu\\var\\www\\app", "\\\\wsl$\\Ubuntu\\opt\\x\\app", "\\\\wsl$\\Ubuntu\\root\\proj\\app"]) {
      expect(gitParentCandidates(guarded, home, win32)).toEqual([]);
    }
  });
});
