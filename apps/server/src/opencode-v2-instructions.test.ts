import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForOmniRushV2Skills } from "./opencode-v2-instructions.js";

describe("waitForOmniRushV2Skills regression tests", () => {
  test("reconciles skills with CRLF line endings in SKILL.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-v2-skills-crlf-"));
    try {
      const skillDir = join(root, ".opencode", "skills", "crlf-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\r\nname: crlf-skill\r\ndescription: A skill with CRLF\r\n---\r\n\r\nInstruction line 1\r\nInstruction line 2\r\n",
        "utf8",
      );

      let reads = 0;
      await waitForOmniRushV2Skills(root, async () => {
        reads++;
        return {
          data: [
            {
              name: "crlf-skill",
              description: "A skill with CRLF",
              location: join(skillDir, "SKILL.md"),
              content: "Instruction line 1\nInstruction line 2",
            },
          ],
        };
      });
      expect(reads).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reconciles skills when native engine omits description", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-v2-skills-nodesc-"));
    try {
      const skillDir = join(root, ".opencode", "skills", "nodesc-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: nodesc-skill\n---\n\nSkill body\n",
        "utf8",
      );

      let reads = 0;
      await waitForOmniRushV2Skills(root, async () => {
        reads++;
        return {
          data: [
            {
              name: "nodesc-skill",
              location: join(skillDir, "SKILL.md"),
              content: "Skill body",
            },
          ],
        };
      });
      expect(reads).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reconciles skills across path separators", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-v2-skills-path-"));
    try {
      const skillDir = join(root, ".opencode", "skills", "path-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: path-skill\ndescription: Path skill\n---\n\nSkill body\n",
        "utf8",
      );

      const slashLocation = join(skillDir, "SKILL.md").replace(/\\/g, "/");
      let reads = 0;
      await waitForOmniRushV2Skills(root, async () => {
        reads++;
        return {
          data: [
            {
              name: "path-skill",
              description: "Path skill",
              location: slashLocation,
              content: "Skill body",
            },
          ],
        };
      });
      expect(reads).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reconciles skills in singular .opencode/skill/ directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-v2-skills-singular-"));
    try {
      const skillDir = join(root, ".opencode", "skill", "singular-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: singular-skill\ndescription: Singular skill\n---\n\nSingular body\n",
        "utf8",
      );

      let reads = 0;
      await waitForOmniRushV2Skills(root, async () => {
        reads++;
        return {
          data: [
            {
              name: "singular-skill",
              description: "Singular skill",
              location: join(skillDir, "SKILL.md"),
              content: "Singular body",
            },
          ],
        };
      });
      expect(reads).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("throws ApiError(502) when native catalog payload is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-v2-skills-invalid-"));
    try {
      await expect(waitForOmniRushV2Skills(root, async () => ({ data: null })))
        .rejects.toMatchObject({ status: 502, code: "engine_skill_sync_failed" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("throws ApiError(504) on timeout instead of generic Error", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnirush-v2-skills-timeout-"));
    try {
      const skillDir = join(root, ".opencode", "skills", "unmatched-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: unmatched-skill\ndescription: Unmatched\n---\n\nBody\n",
        "utf8",
      );

      await expect(waitForOmniRushV2Skills(root, async () => ({ data: [] })))
        .rejects.toMatchObject({ status: 504, code: "engine_skill_sync_timeout" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
