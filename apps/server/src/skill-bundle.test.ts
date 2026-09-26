import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installSkillBundle,
  isSkillBundleJunk,
  listSkillTree,
  normalizeSkillBundlePath,
  prepareSkillBundle,
  resolveProjectSkillDir,
  SKILL_BUNDLE_LIMITS,
  updateSkillFiles,
} from "./skill-bundle.js";
import { listSkills } from "./skills.js";
import { ApiError } from "./errors.js";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const skillMd = (name = "pdf-tools", description = "Work with PDFs") => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nRun scripts/extract.sh\n`;
const file = (path: string, text: string, executable?: boolean) => ({ path, contentBase64: b64(text), ...(executable ? { executable } : {}) });

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof ApiError ? error.code : `non-api:${String(error)}`;
  }
  return "no-error";
}

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "omnirush-skill-bundle-"));
  await mkdir(join(workspace, ".git"), { recursive: true });
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("normalizeSkillBundlePath", () => {
  test("accepts nested relative paths and a leading ./", () => {
    expect(normalizeSkillBundlePath("scripts/extract.sh")).toBe("scripts/extract.sh");
    expect(normalizeSkillBundlePath("./references/api.md")).toBe("references/api.md");
  });

  test.each([
    ["../escape.sh"],
    ["scripts/../../escape.sh"],
    ["/etc/passwd"],
    ["C:/Windows/evil.dll"],
    ["scripts\\evil.sh"],
    ["scripts//double.sh"],
    ["scripts/./x.sh"],
    ["a:b"],
    ["nul.txt"],
    ["trailing-dot."],
    ["ctrl\u0001char"],
    [""],
  ])("refuses %p", (path) => {
    expect(codeOf(() => normalizeSkillBundlePath(path))).toBe("invalid_skill_path");
  });

  test("refuses over-deep and over-long paths", () => {
    expect(codeOf(() => normalizeSkillBundlePath(Array.from({ length: SKILL_BUNDLE_LIMITS.maxDepth + 1 }, () => "d").join("/")))).toBe("invalid_skill_path");
    expect(codeOf(() => normalizeSkillBundlePath("a".repeat(SKILL_BUNDLE_LIMITS.maxPathLength + 1)))).toBe("invalid_skill_path");
  });
});

describe("prepareSkillBundle", () => {
  test("accepts SKILL.md at the root with helpers, marking shebang scripts executable", () => {
    const bundle = prepareSkillBundle({
      files: [
        file("scripts/extract.sh", "#!/bin/sh\necho hi\n"),
        file("SKILL.md", skillMd()),
        file("references/guide.md", "# Guide\n"),
        file("assets/logo.bin", "\u0000\u0001", true),
      ],
    });
    expect(bundle.name).toBe("pdf-tools");
    expect(bundle.description).toBe("Work with PDFs");
    expect(bundle.strippedRoot).toBeNull();
    expect(bundle.files.map((f) => f.path)).toEqual(["SKILL.md", "assets/logo.bin", "references/guide.md", "scripts/extract.sh"]);
    expect(bundle.files.find((f) => f.path === "scripts/extract.sh")?.executable).toBe(true);
    expect(bundle.files.find((f) => f.path === "references/guide.md")?.executable).toBe(false);
    expect(bundle.files.find((f) => f.path === "assets/logo.bin")?.executable).toBe(true);
  });

  test("strips a single wrapping folder (a zipped skill folder)", () => {
    const bundle = prepareSkillBundle({
      files: [file("pdf-tools/SKILL.md", skillMd()), file("pdf-tools/scripts/run.py", "print(1)\n")],
    });
    expect(bundle.strippedRoot).toBe("pdf-tools");
    expect(bundle.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.py"]);
  });

  test("drops OS and VCS junk and reports it", () => {
    const bundle = prepareSkillBundle({
      files: [
        file("SKILL.md", skillMd()),
        file(".DS_Store", "x"),
        file("__MACOSX/._SKILL.md", "x"),
        file(".git/config", "[core]"),
        file("node_modules/x/index.js", "x"),
        file("scripts/__pycache__/a.cpython-312.pyc", "x"),
      ],
    });
    expect(bundle.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    expect(bundle.skipped.sort()).toEqual([".DS_Store", ".git/config", "__MACOSX/._SKILL.md", "node_modules/x/index.js", "scripts/__pycache__/a.cpython-312.pyc"]);
    expect(isSkillBundleJunk("scripts/run.sh")).toBe(false);
  });

  test("requires SKILL.md at the root or under one wrapping folder", () => {
    expect(codeOf(() => prepareSkillBundle({ files: [file("README.md", "x")] }))).toBe("skill_md_missing");
    expect(codeOf(() => prepareSkillBundle({ files: [file("a/SKILL.md", skillMd()), file("b/x.md", "x")] }))).toBe("skill_md_missing");
    expect(codeOf(() => prepareSkillBundle({ files: [file("skill.md", skillMd())] }))).toBe("skill_md_missing");
    expect(codeOf(() => prepareSkillBundle({ files: [] }))).toBe("skill_md_missing");
  });

  test("requires frontmatter with a kebab-case name and a description", () => {
    expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", "# no frontmatter\n")] }))).toBe("invalid_skill_frontmatter");
    expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", "---\ndescription: x\n---\n")] }))).toBe("invalid_skill_frontmatter");
    expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", "---\nname: a\n---\n")] }))).toBe("invalid_skill_frontmatter");
    expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", "---\nname: [unclosed\n---\n")] }))).toBe("invalid_skill_frontmatter");
    expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", skillMd("Not Kebab"))] }))).toBe("invalid_skill_name");
    expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", skillMd("ok", "x".repeat(1025)))] }))).toBe("invalid_skill_frontmatter");
  });

  test("a rename rewrites the frontmatter name and keeps other keys", () => {
    const bundle = prepareSkillBundle({
      files: [file("SKILL.md", "---\nname: pdf-tools\ndescription: Work with PDFs\nlicense: MIT\n---\n\nBody\n")],
      name: "pdf-tools-2",
    });
    const text = bundle.files[0]!.bytes.toString("utf8");
    expect(bundle.name).toBe("pdf-tools-2");
    expect(text).toContain("name: pdf-tools-2");
    expect(text).toContain("license: MIT");
    expect(text.endsWith("Body\n")).toBe(true);
    expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", skillMd())], name: "Bad Name" }))).toBe("invalid_skill_name");
  });

  test("refuses credential-like files by the collector denylist and private key blocks", () => {
    for (const path of [".env", ".env.local", "config/.env.production", "certs/server.pem", "keys/deploy", "id_rsa", "secrets/prod.yaml", "api token.csv", "credentials.json"]) {
      expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", skillMd()), file(path, "x")] }))).toBe("skill_bundle_credentials");
    }
    expect(codeOf(() => prepareSkillBundle({
      files: [file("SKILL.md", skillMd()), file("scripts/deploy.sh", "cat <<EOF\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\nEOF\n")],
    }))).toBe("skill_bundle_credentials");
    // Source and docs that only mention the words are fine.
    expect(prepareSkillBundle({ files: [file("SKILL.md", skillMd()), file("references/token-handling.md", "About tokens")] }).files).toHaveLength(2);
  });

  test("refuses case-insensitive duplicates and file/folder clashes", () => {
    expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", skillMd()), file("a.md", "x"), file("A.md", "y")] }))).toBe("skill_path_collision");
    expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", skillMd()), file("a", "x"), file("a/b.md", "y")] }))).toBe("skill_path_collision");
    expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", skillMd()), file("a/b.md", "y"), file("a", "x")] }))).toBe("skill_path_collision");
  });

  test("enforces file-count and size caps", () => {
    const many = Array.from({ length: SKILL_BUNDLE_LIMITS.maxFiles }, (_, i) => file(`refs/${i}.md`, "x"));
    expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", skillMd()), ...many] }))).toBe("skill_bundle_too_many_files");
    const big = Buffer.alloc(SKILL_BUNDLE_LIMITS.maxFileBytes + 1, 97).toString("base64");
    expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", skillMd()), { path: "big.bin", contentBase64: big }] }))).toBe("skill_file_too_large");
    const chunk = Buffer.alloc(SKILL_BUNDLE_LIMITS.maxFileBytes - 10, 97).toString("base64");
    const total = Array.from({ length: 3 }, (_, i) => ({ path: `big-${i}.bin`, contentBase64: chunk }));
    expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", skillMd()), ...total] }))).toBe("skill_bundle_too_large");
    expect(codeOf(() => prepareSkillBundle({ files: [file("SKILL.md", skillMd()), { path: "x.bin", contentBase64: "not base64!" }] }))).toBe("invalid_skill_file");
  });
});

describe("installSkillBundle", () => {
  test("installs every file with its mode where the engine and the Library find it", async () => {
    const bundle = prepareSkillBundle({
      files: [file("SKILL.md", skillMd()), file("scripts/extract.sh", "#!/bin/sh\necho hi\n"), file("references/guide.md", "# Guide\n")],
    });
    const result = await installSkillBundle(workspace, bundle, { onConflict: "fail" });
    const dir = join(workspace, ".opencode", "skills", "pdf-tools");
    expect(result).toEqual({ path: join(dir, "SKILL.md"), dir, action: "added" });
    expect(await readFile(join(dir, "references", "guide.md"), "utf8")).toBe("# Guide\n");
    expect((await stat(join(dir, "scripts", "extract.sh"))).mode & 0o111).not.toBe(0);
    expect((await stat(join(dir, "references", "guide.md"))).mode & 0o111).toBe(0);
    expect((await listSkills(workspace, false)).map((s) => s.name)).toEqual(["pdf-tools"]);
    // No staging directory is left behind.
    expect((await readdir(join(workspace, ".opencode"))).sort()).toEqual(["skills"]);
  });

  test("a name collision fails unless replacing, and replace swaps the whole folder", async () => {
    const first = prepareSkillBundle({ files: [file("SKILL.md", skillMd()), file("scripts/old.sh", "#!/bin/sh\n")] });
    await installSkillBundle(workspace, first, { onConflict: "fail" });
    const second = prepareSkillBundle({ files: [file("SKILL.md", skillMd("pdf-tools", "v2")), file("scripts/new.sh", "#!/bin/sh\n")] });
    await expect(installSkillBundle(workspace, second, { onConflict: "fail" })).rejects.toMatchObject({ status: 409, code: "skill_exists" });
    const replaced = await installSkillBundle(workspace, second, { onConflict: "replace" });
    expect(replaced.action).toBe("updated");
    const tree = await listSkillTree(replaced.dir);
    expect(tree.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/new.sh"]);
    expect((await listSkills(workspace, false))[0]?.description).toBe("v2");
  });

  test("a collision with a skill outside .opencode/skills/<name> cannot be replaced", async () => {
    await mkdir(join(workspace, ".claude", "skills", "pdf-tools"), { recursive: true });
    await writeFile(join(workspace, ".claude", "skills", "pdf-tools", "SKILL.md"), skillMd());
    const bundle = prepareSkillBundle({ files: [file("SKILL.md", skillMd())] });
    await expect(installSkillBundle(workspace, bundle, { onConflict: "replace" })).rejects.toMatchObject({
      status: 409,
      details: { replaceable: false },
    });
  });
});

describe("updateSkillFiles", () => {
  async function installed() {
    const bundle = prepareSkillBundle({ files: [file("SKILL.md", skillMd()), file("scripts/a.sh", "#!/bin/sh\n"), file("refs/one.md", "1")] });
    await installSkillBundle(workspace, bundle, { onConflict: "fail" });
    return resolveProjectSkillDir(workspace, "pdf-tools");
  }

  test("adds, replaces and removes helper files and prunes empty folders", async () => {
    const dir = await installed();
    const result = await updateSkillFiles(dir, {
      add: [file("scripts/b.py", "print(2)\n"), file("scripts/a.sh", "#!/bin/sh\necho new\n")],
      remove: ["refs/one.md"],
    });
    expect(result).toEqual({ added: ["scripts/b.py", "scripts/a.sh"], removed: ["refs/one.md"] });
    const tree = await listSkillTree(dir);
    expect(tree.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/a.sh", "scripts/b.py"]);
    expect(await readFile(join(dir, "scripts", "a.sh"), "utf8")).toContain("echo new");
    await expect(lstat(join(dir, "refs"))).rejects.toThrow();
  });

  test("protects SKILL.md and refuses unsafe or credential paths", async () => {
    const dir = await installed();
    await expect(updateSkillFiles(dir, { remove: ["SKILL.md"] })).rejects.toMatchObject({ code: "skill_md_protected" });
    await expect(updateSkillFiles(dir, { add: [file("skill.md", "x")] })).rejects.toMatchObject({ code: "skill_md_protected" });
    await expect(updateSkillFiles(dir, { add: [file("../x.sh", "x")] })).rejects.toMatchObject({ code: "invalid_skill_path" });
    await expect(updateSkillFiles(dir, { add: [file(".env", "A=1")] })).rejects.toMatchObject({ code: "skill_bundle_credentials" });
    await expect(updateSkillFiles(dir, { remove: ["missing.md"] })).rejects.toMatchObject({ code: "skill_file_not_found" });
    await expect(updateSkillFiles(dir, { add: [file("scripts", "x")] })).rejects.toMatchObject({ code: "skill_path_collision" });
  });

  test("never writes through a linked folder inside the skill", async () => {
    const dir = await installed();
    const outside = await mkdtemp(join(tmpdir(), "omnirush-skill-outside-"));
    try {
      await symlink(outside, join(dir, "linked"));
      const tree = await listSkillTree(dir);
      expect(tree.files.find((f) => f.path === "linked")?.kind).toBe("symlink");
      await expect(updateSkillFiles(dir, { add: [file("linked/evil.sh", "x")] })).rejects.toMatchObject({ code: "skill_path_collision" });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("only project skills resolve", async () => {
    await expect(resolveProjectSkillDir(workspace, "nope")).rejects.toMatchObject({ status: 404 });
  });
});
