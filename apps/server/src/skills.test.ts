import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSkill, listSkills, renderSkillContentForResponse } from "./skills.js";
import { exists } from "./utils.js";

let workspace: string;

async function writeSkill(dir: string, name: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}\n---\n\nBody\n`, "utf8");
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "omnirush-skills-"));
  await mkdir(join(workspace, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("deleteSkill", () => {
  test("deletes a flat skill", async () => {
    const dir = join(workspace, ".opencode", "skills", "flat-skill");
    await writeSkill(dir, "flat-skill");
    await deleteSkill(workspace, "flat-skill");
    expect(await exists(dir)).toBe(false);
  });

  test("deletes a plugin-namespaced (nested) skill", async () => {
    // Marketplace plugin bundles install skills under skills/<plugin>/<name>/
    const dir = join(workspace, ".opencode", "skills", "bio-research-plugin", "instrument-data-to-allotrope");
    await writeSkill(dir, "instrument-data-to-allotrope");

    const listed = await listSkills(workspace, false);
    expect(listed.map((s) => s.name)).toContain("instrument-data-to-allotrope");

    await deleteSkill(workspace, "instrument-data-to-allotrope");
    expect(await exists(dir)).toBe(false);
  });

  test("404s for unknown skills", async () => {
    await expect(deleteSkill(workspace, "does-not-exist")).rejects.toThrow("Skill not found");
  });
});

describe("listSkills", () => {
  test("lists the engine's singular .opencode/skill/ layout next to .opencode/skills/", async () => {
    // OpenCode's documented default is `.opencode/skill/<name>/SKILL.md`; the
    // desktop writes the plural spelling. The engine loads both, so both must
    // be visible (and deletable) in the GUI.
    await writeSkill(join(workspace, ".opencode", "skills", "plural-skill"), "plural-skill");
    await writeSkill(join(workspace, ".opencode", "skill", "singular-skill"), "singular-skill");

    const listed = await listSkills(workspace, false);
    expect(listed.map((skill) => skill.name).sort()).toEqual(["plural-skill", "singular-skill"]);
    expect(listed.every((skill) => skill.scope === "project")).toBe(true);

    const singularDir = join(workspace, ".opencode", "skill", "singular-skill");
    await deleteSkill(workspace, "singular-skill");
    expect(await exists(singularDir)).toBe(false);
  });

  test("keeps a skill whose frontmatter name differs from its folder, under the engine's name", async () => {
    // The engine registers a skill by its frontmatter `name`; hiding it here
    // would leave the model with a skill the GUI cannot show or remove.
    const dir = join(workspace, ".opencode", "skills", "folder-name");
    await writeSkill(dir, "frontmatter-name");

    const listed = await listSkills(workspace, false);
    expect(listed.map((skill) => skill.name)).toEqual(["frontmatter-name"]);
    expect(listed[0]?.path).toBe(join(dir, "SKILL.md"));

    await deleteSkill(workspace, "frontmatter-name");
    expect(await exists(dir)).toBe(false);
  });

  test("resolves global skills through the engine's config directory env (OPENCODE_CONFIG_DIR / XDG_CONFIG_HOME / HOME)", async () => {
    const previous = {
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    };
    const home = await mkdtemp(join(tmpdir(), "omnirush-skills-home-"));
    const xdg = join(home, "xdg");
    const explicit = join(home, "explicit-opencode");
    try {
      process.env.HOME = home;
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.OPENCODE_CONFIG_DIR;
      await writeSkill(join(home, ".config", "opencode", "skills", "home-skill"), "home-skill");
      await writeSkill(join(home, ".config", "opencode", "skill", "home-singular"), "home-singular");
      await writeSkill(join(home, ".claude", "skills", "claude-global"), "claude-global");
      await writeSkill(join(home, ".agents", "skills", "agents-global"), "agents-global");
      expect((await listSkills(workspace, true)).map((skill) => `${skill.scope}:${skill.name}`).sort()).toEqual([
        "global:agents-global",
        "global:claude-global",
        "global:home-singular",
        "global:home-skill",
      ]);
      expect((await listSkills(workspace, false))).toEqual([]);

      process.env.XDG_CONFIG_HOME = xdg;
      await writeSkill(join(xdg, "opencode", "skills", "xdg-skill"), "xdg-skill");
      const viaXdg = (await listSkills(workspace, true)).map((skill) => skill.name);
      expect(viaXdg).toContain("xdg-skill");
      expect(viaXdg).not.toContain("home-skill");

      process.env.OPENCODE_CONFIG_DIR = explicit;
      await writeSkill(join(explicit, "skills", "explicit-skill"), "explicit-skill");
      const viaExplicit = (await listSkills(workspace, true)).map((skill) => skill.name);
      expect(viaExplicit).toContain("explicit-skill");
      expect(viaExplicit).not.toContain("xdg-skill");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  test("returns skills with malformed YAML frontmatter as visible errors", async () => {
    const validDir = join(workspace, ".opencode", "skills", "valid-skill");
    await writeSkill(validDir, "valid-skill");

    const invalidDir = join(workspace, ".opencode", "skills", "invalid-skill");
    await mkdir(invalidDir, { recursive: true });
    const invalidContent = `---\nname: invalid-skill\ndescription: Use when searching the web, looking up facts, researching technology: trends\n---\n\nBody\n`;
    await writeFile(
      join(invalidDir, "SKILL.md"),
      invalidContent,
      "utf8",
    );

    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      const listed = await listSkills(workspace, false);
      const names = listed.map((skill) => skill.name);
      const invalid = listed.find((skill) => skill.name === "invalid-skill");

      expect(names).toContain("valid-skill");
      expect(names).toContain("invalid-skill");
      expect(invalid?.description.startsWith("ERROR: Invalid skill frontmatter")).toBe(true);
      expect(invalid?.error).toContain("Nested mappings are not allowed");
      expect(invalid ? renderSkillContentForResponse(invalid, invalidContent) : "").toContain("ERROR: This skill has invalid YAML frontmatter");
      expect(invalid ? renderSkillContentForResponse(invalid, invalidContent) : "").toContain(invalidContent);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.[0]).toBe("[omnirush:skills] Found invalid skill frontmatter");
    } finally {
      console.warn = originalWarn;
    }
  });
});
