import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { gitMarkerDetector, isArchivableProject, type ProjectMarkerDetector } from "./detect.js";
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
});
