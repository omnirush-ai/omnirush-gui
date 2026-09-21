import { describe, expect, test } from "bun:test";
import type { OmniRushSessionSnapshot } from "../src/app/lib/omnirush-server";

import { normalizeWorkspaceAuditEntries } from "../src/react-app/domains/audit/normalize-workspace-audit";
import { createAuditTrailExport, projectSessionAudit, serializeAuditTrailExport } from "../src/react-app/domains/audit/project-session-audit";
import { redactAuditValue } from "../src/react-app/domains/audit/redact-audit-value";

function snapshot(messages: unknown[], status: unknown = { type: "idle" }) {
  return { session: { id: "ses_1" }, messages, todos: [], status } as unknown as OmniRushSessionSnapshot;
}

describe("audit trail projection", () => {
  test("projects user, assistant and paired tool records with durable timing and usage", () => {
    const records = projectSessionAudit(snapshot([
      { info: { id: "u1", role: "user", time: { created: 10 } }, parts: [{ id: "u-text", type: "text", text: "Read the report" }] },
      { info: { id: "a1", role: "assistant", time: { created: 20, completed: 80 }, model: { providerID: "openai", modelID: "gpt-5" }, tokens: { input: 12, output: 7 }, cost: 0.01 }, parts: [
        { id: "t1", type: "tool", callID: "call-1", tool: "read", time: { created: 30, completed: 50 }, state: { status: "completed", input: { filePath: "report.pdf" }, output: "contents" } },
      ] },
    ]), "ws_1");
    expect(records.map((record) => record.kind)).toEqual(["user", "assistant", "tool"]);
    expect(records.find((record) => record.kind === "tool")).toMatchObject({ id: "tool:call-1", callId: "call-1", durationMs: 20, status: "completed" });
    expect(records.find((record) => record.kind === "assistant")).toMatchObject({ provider: "openai", model: "gpt-5", durationMs: 60, usage: { input: 12, output: 7 } });
  });

  test("keeps a pending tool running, and represents failed and cancelled turns", () => {
    const records = projectSessionAudit(snapshot([
      { info: { id: "a-running", role: "assistant", time: { created: 100 } }, parts: [{ id: "p", type: "tool", callID: "same", tool: "bash", state: { status: "running", input: { command: "echo hi" }, time: { start: 120 } } }] },
      { info: { id: "a-failed", role: "assistant", time: { created: 200, completed: 210 }, error: { name: "ProviderError", message: "Bearer sk-test-secret" } }, parts: [] },
      { info: { id: "a-cancelled", role: "assistant", finish: "cancelled", time: { created: 300, completed: 301 } }, parts: [] },
    ], { type: "busy" }));
    expect(records.find((record) => record.id === "tool:same")).toMatchObject({ status: "running", startedAt: 120 });
    expect(records.find((record) => record.id === "message:a-failed")).toMatchObject({ status: "failed" });
    expect(records.find((record) => record.id === "message:a-cancelled")).toMatchObject({ status: "cancelled" });
    expect(JSON.stringify(records)).not.toContain("sk-test-secret");
  });

  test("pairs a repeated callID with its terminal result", () => {
    const records = projectSessionAudit(snapshot([{ info: { id: "a", role: "assistant", time: { created: 1 } }, parts: [
      { id: "part-1", type: "tool", callID: "call-1", tool: "read", time: { created: 2 }, state: { status: "running", input: { filePath: "a.txt" } } },
      { id: "part-2", type: "tool", callID: "call-1", tool: "read", time: { created: 2, completed: 8 }, state: { status: "completed", input: { filePath: "a.txt" }, output: "ok" } },
    ] }]));
    expect(records.filter((record) => record.kind === "tool")).toHaveLength(1);
    expect(records.find((record) => record.kind === "tool")).toMatchObject({ status: "completed", durationMs: 6 });
  });

  test("deduplicates source ids and emits artifact paths", () => {
    const records = projectSessionAudit(snapshot([
      { info: { id: "a", role: "assistant", time: { created: 1 } }, parts: [
        { id: "f", type: "file", filename: "/workspace/out/note.docx", mime: "application/vnd.openxmlformats" },
        { id: "f", type: "file", filename: "/workspace/out/note.docx", mime: "application/vnd.openxmlformats" },
      ] },
    ]), { workspaceId: "ws", workspacePath: "/workspace" });
    expect(records.filter((record) => record.kind === "artifact")).toHaveLength(1);
    expect(records.find((record) => record.kind === "artifact")).toMatchObject({ path: "out/note.docx" });
  });

  test("exports projected records deterministically with explicit partial-history scope", () => {
    const records = projectSessionAudit(snapshot([{ info: { id: "u", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "hello" }] }]), "ws");
    const scope = { workspaceId: "ws", sessionId: "ses_1", generatedAt: 123, partialHistory: true };
    expect(createAuditTrailExport(records, scope)).toMatchObject({
      schemaVersion: 1,
      scope: { workspaceId: "ws", sessionId: "ses_1" },
      generatedAt: 123,
      partialHistory: true,
    });
    expect(serializeAuditTrailExport(records, scope)).toBe(serializeAuditTrailExport(records, scope));
  });
});

describe("audit trail redaction and workspace normalization", () => {
  test("redacts sensitive keys, known secret patterns, query values, and bounds data", () => {
    const value = redactAuditValue({ apiKey: "sk-live-secret", headers: { Authorization: "Bearer abcdefghijklmnop" }, url: "https://example.test?a=1&token=hidden", nested: ["x".repeat(100)] }, { maxStringLength: 20 });
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain("abcdefghijklmnop");
    expect(serialized).not.toContain("hidden");
    expect(serialized).toContain("[REDACTED]");
  });

  test("normalizes workspace paths, preserves ordering, and deduplicates IDs", () => {
    const records = normalizeWorkspaceAuditEntries([
      { id: "b", workspaceId: "ws", actor: { type: "host" }, action: "upload", target: "/other/secret.pdf", summary: "Uploaded report", timestamp: 20 },
      { id: "a", workspaceId: "ws", actor: { type: "remote" }, action: "write", target: "/workspace/docs/note.docx", summary: "Wrote note", timestamp: 10 },
      { id: "a", workspaceId: "ws", actor: { type: "remote" }, action: "write", target: "/workspace/docs/note.docx", summary: "Wrote note", timestamp: 10 },
    ], { workspacePath: "/workspace" });
    expect(records.map((record) => record.id)).toEqual(["workspace:a", "workspace:b"]);
    expect(records[0]).toMatchObject({ target: "docs/note.docx", actor: "remote" });
    expect(records[1]).toMatchObject({ target: "secret.pdf" });
  });
});
