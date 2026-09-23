import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

import { folderDetector, gitMarkerDetector, gitParentCandidates, gitParentDetector, isArchivableProject, refusedFolderRoot, type FolderGateContext, type ProjectMarkerDetector } from "./detect.js";
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

describe("all-folders gate (4.4)", () => {
  const FOLDER = { archivable: true, reason: "folder", marker: "folder" };
  const NO_MARKER = { archivable: false, reason: "no_marker", marker: null };

  /** A policy stub that counts how often it was asked. */
  function policy(allFolders: boolean, touchedFiles = false) {
    const asked = { count: 0 };
    return { asked, read: async () => (asked.count += 1, { allFolders, touchedFiles }) };
  }

  test("policy off: a folder without .git stays not archivable, exactly as git-only", async () => {
    const home = await tempDir("folder-home");
    await mkdir(join(home, "notes"));
    const off = policy(false);
    expect(await isArchivableProject(join(home, "notes"), [gitMarkerDetector, folderDetector(off.read, { homeDir: home })])).toEqual(NO_MARKER);
    expect(off.asked.count).toBe(1);
  });

  test("policy on: a folder under home is archivable; home itself is refused before the policy is asked", async () => {
    const home = await tempDir("folder-home");
    await mkdir(join(home, "projects/x"), { recursive: true });
    const on = policy(true);
    const detectors = [gitMarkerDetector, folderDetector(on.read, { homeDir: home })];
    expect(await isArchivableProject(join(home, "projects/x"), detectors)).toEqual(FOLDER);
    expect(await isArchivableProject(join(home, "projects"), detectors)).toEqual(FOLDER);
    expect(on.asked.count).toBe(2);
    expect(await isArchivableProject(home, detectors, { homeDir: home })).toEqual({ archivable: false, reason: "root_too_broad", marker: null });
    // The folder detector refuses home by itself too, without asking.
    expect(await folderDetector(on.read, { homeDir: home })(home)).toBeNull();
    expect(on.asked.count).toBe(2);
  });

  test("git is still preferred, and any .git entry keeps the git result without asking the policy", async () => {
    const home = await tempDir("folder-home");
    const on = policy(true);
    const detectors = [gitMarkerDetector, folderDetector(on.read, { homeDir: home })];
    await mkdir(join(home, "repo/.git"), { recursive: true });
    expect(await isArchivableProject(join(home, "repo"), detectors)).toEqual({ archivable: true, reason: "git_dir", marker: ".git" });
    await mkdir(join(home, "broken"));
    await writeFile(join(home, "broken/.git"), "not a gitfile\n");
    expect((await isArchivableProject(join(home, "broken"), detectors)).reason).toBe("gitfile_invalid");
    await mkdir(join(home, "linked"));
    await symlink(join(home, "repo/.git"), join(home, "linked/.git"));
    expect(await isArchivableProject(join(home, "linked"), detectors)).toEqual(NO_MARKER);
    expect(on.asked.count).toBe(0);
  });

  test("the userData dir, a folder inside or above it, a system directory and a path that resolves into one are refused without asking", async () => {
    const home = await tempDir("folder-home");
    const userData = join(home, ".config/OmniRush.ai");
    await mkdir(join(userData, "managed-opencode-workdir"), { recursive: true });
    await symlink("/usr", join(home, "system"));
    const on = policy(true);
    const detector = folderDetector(on.read, { homeDir: home, userDataDir: userData });
    for (const root of [userData, join(userData, "managed-opencode-workdir"), join(home, ".config"), join(home, "system/share"), "/usr", "/usr/share"]) {
      expect({ root, result: await detector(root) }).toEqual({ root, result: null });
    }
    expect(await isArchivableProject(join(home, "system/share"), [gitMarkerDetector, detector])).toEqual(NO_MARKER);
    expect(on.asked.count).toBe(0);
  });

  test("every refusal, on macOS, Linux and Windows paths", () => {
    const mac: FolderGateContext = { platform: "darwin", homes: ["/Users/sam"], userData: ["/Users/sam/Library/Application Support/ai.omnirush.desktop"] };
    const linux: FolderGateContext = { platform: "linux", homes: ["/home/sam"], userData: ["/home/sam/.config/ai.omnirush.desktop"] };
    const windows: FolderGateContext = { platform: "win32", homes: ["C:\\Users\\sam"], userData: ["C:\\Users\\sam\\AppData\\Roaming\\ai.omnirush.desktop"] };
    const cases: Array<[FolderGateContext, string, ReturnType<typeof refusedFolderRoot>]> = [
      // Filesystem, drive and share roots.
      [mac, "/", "root_too_broad"],
      [mac, "/Volumes", "root_too_broad"],
      [mac, "/Volumes/Backup", "root_too_broad"],
      [linux, "/mnt", "root_too_broad"],
      [linux, "/mnt/c", "root_too_broad"],
      [linux, "/media/sam/usb", "root_too_broad"],
      [windows, "C:\\", "root_too_broad"],
      [windows, "D:\\", "root_too_broad"],
      [windows, "\\\\server\\share", "root_too_broad"],
      [windows, "\\\\server\\share\\", "root_too_broad"],
      // Home itself and anything above it.
      [mac, "/Users/sam", "root_too_broad"],
      [mac, "/users/SAM/", "root_too_broad"],
      [mac, "/Users", "root_too_broad"],
      [linux, "/home/sam", "root_too_broad"],
      [linux, "/home", "root_too_broad"],
      [windows, "C:\\Users\\sam", "root_too_broad"],
      [windows, "c:\\users\\SAM", "root_too_broad"],
      [windows, "C:\\Users", "root_too_broad"],
      // The userData dir, inside it, and above it.
      [mac, "/Users/sam/Library/Application Support/ai.omnirush.desktop", "root_app_data"],
      [mac, "/Users/sam/Library/Application Support/ai.omnirush.desktop/managed-opencode-workdir", "root_app_data"],
      [mac, "/Users/sam/Library/Application Support", "root_app_data"],
      [mac, "/Users/sam/Library", "root_app_data"],
      [linux, "/home/sam/.config/ai.omnirush.desktop", "root_app_data"],
      [linux, "/home/sam/.config", "root_app_data"],
      [windows, "C:\\Users\\sam\\AppData\\Roaming\\ai.omnirush.desktop\\logs", "root_app_data"],
      [windows, "C:\\Users\\sam\\AppData\\Roaming", "root_app_data"],
      [windows, "C:\\Users\\sam\\AppData", "root_app_data"],
      // AppData itself is refused with no userData dir known too.
      [{ ...windows, userData: [] }, "C:\\Users\\sam\\AppData", "root_app_data"],
      // System and app directories, and anything inside them.
      ...["/System", "/System/Library", "/Library", "/Library/Developer/x", "/Applications", "/Applications/Foo.app", "/usr", "/usr/local/src/x", "/bin", "/etc", "/var", "/var/folders/ab/T/x", "/private", "/private/tmp/x", "/library/x"].map((root): [FolderGateContext, string, "root_system"] => [mac, root, "root_system"]),
      ...["/usr", "/usr/share/x", "/etc", "/var/www/site", "/opt", "/opt/app", "/proc", "/proc/1", "/sys", "/sys/class"].map((root): [FolderGateContext, string, "root_system"] => [linux, root, "root_system"]),
      ...[
        "C:\\Windows",
        "C:\\Windows\\System32",
        "c:\\windows",
        "D:\\Windows",
        "C:\\Program Files",
        "C:\\Program Files\\App",
        "C:\\Program Files (x86)\\App",
        "C:\\ProgramData",
        "C:\\ProgramData\\App",
        "C:\\Windows.old\\Users\\sam",
        "C:\\$Recycle.Bin\\S-1-5-21",
        "C:\\Recovery",
      ].map((root): [FolderGateContext, string, "root_system"] => [windows, root, "root_system"]),
      ...["C:\\Users\\sam\\AppData\\Local", "C:\\Users\\sam\\AppData\\Local\\Temp\\x", "C:\\Users\\sam\\appdata\\locallow"].map((root): [FolderGateContext, string, "root_app_data"] => [windows, root, "root_app_data"]),
      // Allowed: folders under home, and elsewhere outside system directories.
      [mac, "/Users/sam/omnirush.ai", null],
      [mac, "/Users/sam/projects/x", null],
      [mac, "/Users/sam/Library/Mobile Documents/com~apple~CloudDocs/x", "root_app_data"],
      [mac, "/Volumes/Backup/projects/x", null],
      [mac, "/Users/other/x", null],
      [linux, "/home/sam/omnirush.ai", null],
      [linux, "/home/sam/.local/share/x", "root_app_data"],
      [linux, "/srv/site", null],
      [linux, "/tmp/scratch", null],
      [linux, "/Library/x", "root_system"],
      [windows, "C:\\Users\\sam\\omnirush.ai", null],
      [windows, "C:\\Users\\sam\\projects\\x", null],
      [windows, "D:\\work\\x", null],
      [windows, "D:\\Windows Backup", null],
      [windows, "\\\\server\\share\\projects\\x", null],
    ];
    for (const [context, root, expected] of cases) {
      expect({ root, refused: refusedFolderRoot(root, context) }).toEqual({ root, refused: expected });
    }
  });

  test("credential and app-data folders are refused as the session folder, wherever they are and on every platform", () => {
    const mac: FolderGateContext = { platform: "darwin", homes: ["/Users/sam"], userData: [] };
    const linux: FolderGateContext = { platform: "linux", homes: ["/home/sam"], userData: [] };
    const windows: FolderGateContext = { platform: "win32", homes: ["C:\\Users\\sam"], userData: [] };
    const cases: Array<[FolderGateContext, string, ReturnType<typeof refusedFolderRoot>]> = [
      // Credential stores in home, and anything inside them.
      ...[".ssh", ".aws", ".aws/sso/cache", ".gnupg", ".kube", ".docker", ".config/gcloud", ".config/gcloud/legacy_credentials", ".password-store", ".azure", "Library/Keychains"].flatMap(
        (dir): Array<[FolderGateContext, string, "root_credentials"]> => [[mac, `/Users/sam/${dir}`, "root_credentials"], [linux, `/home/sam/${dir}`, "root_credentials"]],
      ),
      [mac, "/Users/sam/.SSH", "root_credentials"],
      [windows, "C:\\Users\\sam\\.ssh", "root_credentials"],
      [windows, "C:\\Users\\sam\\.aws\\sso", "root_credentials"],
      [windows, "C:\\Users\\sam\\.docker", "root_credentials"],
      [windows, "C:\\Users\\sam\\.kube", "root_credentials"],
      // The same names outside home: a backup disk, another account, a synced copy.
      [mac, "/Volumes/Backup/Users/sam/.aws", "root_credentials"],
      [mac, "/Volumes/Backup/Users/sam/.gnupg/private-keys-v1.d", "root_credentials"],
      [mac, "/Volumes/Backup/Library/Keychains", "root_credentials"],
      [mac, "/Users/sam/Dropbox/dotfiles/.ssh", "root_credentials"],
      [linux, "/srv/backup/sam/.kube", "root_credentials"],
      [linux, "/mnt/data/home/.config/gcloud", "root_credentials"],
      [windows, "D:\\Backup\\.gnupg", "root_credentials"],
      // Folders the collector's denylist denies as a whole.
      ...["work/keys", "work/secrets", "work/credentials", "work/aws-credentials", "work/prod.secrets", "work/.env.d", "work/certs.pem", "work/app/node_modules/pkg", "work/repo/.git/hooks"].map(
        (dir): [FolderGateContext, string, "root_credentials"] => [mac, `/Users/sam/${dir}`, "root_credentials"],
      ),
      [windows, "C:\\Users\\sam\\work\\Secrets", "root_credentials"],
      // App data: every dot folder in home, macOS Library, Linux snap, Windows AppData, Library/Application Support anywhere.
      ...[".config", ".config/gh", ".local", ".local/share/keyrings", ".cache/x", ".mozilla/firefox", ".Trash", ".vscode/extensions", ".npm"].map(
        (dir): [FolderGateContext, string, "root_app_data"] => [linux, `/home/sam/${dir}`, "root_app_data"],
      ),
      ...["Library", "Library/Application Support/Google/Chrome/Default", "Library/Cookies", "Library/Containers/com.x", "Library/Group Containers/x", "library/mail", ".config/gh", ".Trash"].map(
        (dir): [FolderGateContext, string, "root_app_data"] => [mac, `/Users/sam/${dir}`, "root_app_data"],
      ),
      [linux, "/home/sam/snap/firefox/common", "root_app_data"],
      [linux, "/home/sam/Library/x", null],
      [windows, "C:\\Users\\sam\\.vscode", "root_app_data"],
      [windows, "C:\\Users\\sam\\AppData\\Roaming\\gcloud", "root_app_data"],
      [windows, "D:\\Backup\\AppData\\Roaming", "root_app_data"],
      [mac, "/Volumes/Backup/Users/sam/Library/Application Support/x", "root_app_data"],
      // Other accounts and shared folders beside home: refused themselves, and their app data.
      [mac, "/Users/other", "root_too_broad"],
      [mac, "/Users/Shared", "root_too_broad"],
      [mac, "/Users/other/Library/Cookies", "root_app_data"],
      [mac, "/Users/other/.config", "root_app_data"],
      [mac, "/Users/other/.ssh", "root_credentials"],
      [linux, "/home/other", "root_too_broad"],
      [linux, "/home/other/.local/share", "root_app_data"],
      [windows, "C:\\Users\\Public", "root_too_broad"],
      [windows, "C:\\Users\\Default\\AppData\\Local", "root_app_data"],
      [windows, "C:\\Users\\other\\.ssh", "root_credentials"],
      // Still allowed: ordinary folders, including names the denylist only checks on files.
      [mac, "/Users/sam/work/token-service", null],
      [mac, "/Users/sam/work/keyboard-firmware", null],
      [mac, "/Users/sam/Documents/report", null],
      [mac, "/Users/sam/Library-notes", null],
      [mac, "/Users/Shared/project", null],
      [mac, "/Users/other/project", null],
      [linux, "/home/sam/work/dotfiles-site", null],
      [windows, "C:\\Users\\sam\\work\\x", null],
    ];
    for (const [context, root, expected] of cases) {
      expect({ root, refused: refusedFolderRoot(root, context) }).toEqual({ root, refused: expected });
    }
  });

  test("Windows device and long paths, and names with trailing dots or spaces, are refused like their plain form", () => {
    const windows: FolderGateContext = { platform: "win32", homes: ["C:\\Users\\sam"], userData: [] };
    const cases: Array<[string, ReturnType<typeof refusedFolderRoot>]> = [
      ["\\\\?\\C:\\Users\\sam", "root_too_broad"],
      ["\\\\?\\c:\\users\\SAM\\", "root_too_broad"],
      ["\\\\.\\C:\\", "root_too_broad"],
      ["\\\\?\\UNC\\server\\share", "root_too_broad"],
      ["\\\\?\\UNC\\server\\share\\", "root_too_broad"],
      ["C:\\Users\\sam.", "root_too_broad"],
      ["C:\\Users\\sam. .", "root_too_broad"],
      ["C:\\Users\\sam \\", "root_too_broad"],
      ["C:\\Users.\\sam", "root_too_broad"],
      ["\\\\.\\C:\\Windows\\System32", "root_system"],
      ["\\\\?\\C:\\Program Files.\\App", "root_system"],
      ["\\\\?\\C:\\Users\\sam\\AppData\\Local", "root_app_data"],
      ["C:\\Users\\sam\\AppData.\\Local", "root_app_data"],
      ["\\\\?\\C:\\Users\\sam\\.ssh", "root_credentials"],
      ["C:\\Users\\sam\\.ssh.", "root_credentials"],
      ["\\\\?\\C:\\Users\\sam\\projects\\x", null],
      ["\\\\?\\UNC\\server\\share\\projects\\x", null],
    ];
    for (const [root, expected] of cases) {
      expect({ root, refused: refusedFolderRoot(root, windows) }).toEqual({ root, refused: expected });
    }
  });

  test("on disk: a session started in a credential or app-data folder, or through a link into one, is refused without asking the policy", async () => {
    const home = await tempDir("folder-home");
    const roots = [".gnupg", ".aws/sso/cache", ".docker", ".ssh", ".kube", ".config/gh", ".config/gcloud", "Library/Keychains", "work/secrets", "AppData/Roaming/x"];
    for (const dir of roots) await mkdir(join(home, dir), { recursive: true });
    await writeFile(join(home, ".gnupg/secring.gpg"), "secret keyring");
    await mkdir(join(home, "work/links"), { recursive: true });
    await symlink(join(home, ".aws"), join(home, "work/links/aws"));
    const on = policy(true);
    const detector = folderDetector(on.read, { homeDir: home });
    // work/links/aws/sso is a real directory reached through a link: its resolved form is ~/.aws/sso.
    for (const root of [...roots.map((dir) => join(home, dir)), join(home, "work/links/aws/sso")]) {
      expect({ root, result: await detector(root) }).toEqual({ root, result: null });
      expect({ root, gate: await isArchivableProject(root, [gitMarkerDetector, detector]) }).toEqual({ root, gate: NO_MARKER });
    }
    expect(on.asked.count).toBe(0);
    await mkdir(join(home, "work/app"));
    expect(await detector(join(home, "work/app"))).toEqual(FOLDER);
    expect(on.asked.count).toBe(1);
  });

  test("a home directory under a system directory keeps its folders, but a home at the disk root does not open the system directories", () => {
    expect(refusedFolderRoot("/var/root/project", { platform: "darwin", homes: ["/var/root"], userData: [] })).toBeNull();
    expect(refusedFolderRoot("/var/root", { platform: "darwin", homes: ["/var/root"], userData: [] })).toBe("root_too_broad");
    expect(refusedFolderRoot("/usr/share/x", { platform: "linux", homes: ["/"], userData: [] })).toBe("root_system");
  });
});
