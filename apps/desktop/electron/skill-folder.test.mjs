import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readSkillFolder, SKILL_FOLDER_LIMITS } from "./skill-folder.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omnirush-skill-folder-"));
  const skill = path.join(root, "greeter");
  await mkdir(path.join(skill, "scripts"), { recursive: true });
  await mkdir(path.join(skill, "node_modules", "dep"), { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: greeter\ndescription: Greets\n---\n");
  await writeFile(path.join(skill, "scripts", "greet.sh"), "#!/bin/sh\necho hi\n");
  await chmod(path.join(skill, "scripts", "greet.sh"), 0o755);
  await writeFile(path.join(skill, ".DS_Store"), "junk");
  await writeFile(path.join(skill, "node_modules", "dep", "index.js"), "x");
  return { root, skill };
}

test("reads a skill folder with relative paths and exec bits, skipping junk", async () => {
  const { root, skill } = await fixture();
  try {
    const result = await readSkillFolder(skill);
    assert.equal(result.name, "greeter");
    assert.deepEqual(result.files.map((f) => f.path).sort(), ["SKILL.md", "scripts/greet.sh"]);
    const script = result.files.find((f) => f.path === "scripts/greet.sh");
    assert.equal(Buffer.from(script.contentBase64, "base64").toString(), "#!/bin/sh\necho hi\n");
    if (process.platform !== "win32") assert.equal(script.executable, true);
    assert.equal(result.files.find((f) => f.path === "SKILL.md").executable, false);
    assert.deepEqual(result.skipped.sort(), [".DS_Store", "node_modules/"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a folder holding links", { skip: process.platform === "win32" }, async () => {
  const { root, skill } = await fixture();
  try {
    await symlink("/etc/hostname", path.join(skill, "scripts", "leak"));
    await assert.rejects(readSkillFolder(skill), /cannot contain links.*scripts\/leak/);
    await assert.rejects(readSkillFolder(path.join(root, "missing")));
    await assert.rejects(readSkillFolder("relative/path"), /Choose a skill folder/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stops at the size and count caps", async () => {
  const { root, skill } = await fixture();
  try {
    await assert.rejects(readSkillFolder(skill, { limits: { ...SKILL_FOLDER_LIMITS, maxFiles: 1 } }), /more than 1 files/);
    await assert.rejects(readSkillFolder(skill, { limits: { ...SKILL_FOLDER_LIMITS, maxTotalBytes: 20 } }), /larger than/);
    await assert.rejects(readSkillFolder(skill, { limits: { ...SKILL_FOLDER_LIMITS, maxFileBytes: 5 } }), /larger than/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
