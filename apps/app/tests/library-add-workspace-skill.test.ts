import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  suggestWorkspaceSkillName,
  validateWorkspaceSkillDraft,
  workspaceSkillAddAvailable,
  WORKSPACE_SKILL_DESCRIPTION_MAX_LENGTH,
} from "../src/react-app/domains/settings/pages/library-add-workspace-skill-modal";

const mcpViewSource = readFileSync(
  join(import.meta.dir, "../src/react-app/domains/settings/pages/mcp-view.tsx"),
  "utf8",
);

describe("workspace skill authoring availability", () => {
  test("offers the workspace file path only without a Cloud organization", () => {
    expect(workspaceSkillAddAvailable({
      cloudSignedIn: false,
      allowManageExtensions: true,
      canCreateWorkspaceSkill: true,
    })).toBe(true);
    // Cloud members keep the Den authoring modal.
    expect(workspaceSkillAddAvailable({
      cloudSignedIn: true,
      allowManageExtensions: true,
      canCreateWorkspaceSkill: true,
    })).toBe(false);
  });

  test("respects the local extensions policy and the server's write capability", () => {
    expect(workspaceSkillAddAvailable({
      cloudSignedIn: false,
      allowManageExtensions: false,
      canCreateWorkspaceSkill: true,
    })).toBe(false);
    expect(workspaceSkillAddAvailable({
      cloudSignedIn: false,
      allowManageExtensions: true,
      canCreateWorkspaceSkill: false,
    })).toBe(false);
  });
});

describe("workspace skill draft validation", () => {
  const valid = {
    name: "release-notes",
    description: "Draft release notes from the git log.",
    content: "# Release notes\n\nSteps.",
  };

  test("accepts a kebab-case name with description and body", () => {
    expect(validateWorkspaceSkillDraft(valid)).toBeNull();
    expect(validateWorkspaceSkillDraft({ ...valid, name: "  release-notes  " })).toBeNull();
  });

  test("mirrors the server's name rule (kebab-case, 1-64 chars)", () => {
    expect(validateWorkspaceSkillDraft({ ...valid, name: "" })).toBe("name_required");
    expect(validateWorkspaceSkillDraft({ ...valid, name: "Release Notes" })).toBe("name_invalid");
    expect(validateWorkspaceSkillDraft({ ...valid, name: "release--notes" })).toBe("name_invalid");
    expect(validateWorkspaceSkillDraft({ ...valid, name: "-release" })).toBe("name_invalid");
    expect(validateWorkspaceSkillDraft({ ...valid, name: "a".repeat(65) })).toBe("name_invalid");
    expect(validateWorkspaceSkillDraft({ ...valid, name: "a".repeat(64) })).toBeNull();
  });

  test("mirrors the server's description rule (1-1024 chars) and requires a body", () => {
    expect(validateWorkspaceSkillDraft({ ...valid, description: "   " })).toBe("description_required");
    expect(validateWorkspaceSkillDraft({
      ...valid,
      description: "d".repeat(WORKSPACE_SKILL_DESCRIPTION_MAX_LENGTH + 1),
    })).toBe("description_too_long");
    expect(validateWorkspaceSkillDraft({ ...valid, content: "\n\n" })).toBe("content_required");
  });

  test("suggests a kebab-case name from free text", () => {
    expect(suggestWorkspaceSkillName("Release Notes")).toBe("release-notes");
    expect(suggestWorkspaceSkillName("  Draft: the PR!  ")).toBe("draft-the-pr");
    expect(suggestWorkspaceSkillName("x".repeat(80)).length).toBe(64);
  });
});

describe("Library wiring", () => {
  test("McpView offers the workspace skill modal when the Den action is unavailable", () => {
    expect(mcpViewSource).toContain("createWorkspaceSkill?: (input: WorkspaceSkillDraft) => Promise<void>;");
    expect(mcpViewSource).toContain('(kind === "skill" && workspaceSkillAdd)');
    expect(mcpViewSource).toContain('if (kind === "skill" && workspaceSkillAdd) setWorkspaceSkillModalOpen(true);');
    expect(mcpViewSource).toContain("<LibraryAddWorkspaceSkillModal");
  });
});
