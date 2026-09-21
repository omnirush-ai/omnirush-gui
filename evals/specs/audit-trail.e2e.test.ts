import { expect } from "vitest";
import { spec } from "@omnirush/testkit";
import { auditMarkdown } from "../worlds/audit.ts";
import { streamedMarkdownMarker } from "../worlds/chat.ts";

declare global {
  interface Window {
    __auditExportBlob?: Blob;
    __auditExportFilename?: string;
  }
}

const test = spec.world(auditMarkdown, { timeout: 420_000 });
const prompt = `Write the streamed markdown answer. ${streamedMarkdownMarker}`;
const completion = "Closing paragraph epsilon.";

test("audit trail keeps the task in place, exposes details, and exports a sanitized projection", async ({ user, probe, step, evidence }) => {
  await user.type("composer", prompt);
  await user.click("Run task");
  await user.see({ text: completion }, { timeoutMs: 120_000 });

  const routeBefore = await probe.hash();
  await step("opening Audit trail keeps the completed chat mounted", async () => {
    await user.click({ testId: "audit-trail-toggle" });
    await user.see({ testId: "audit-trail-panel" });
    await user.see({ testId: "audit-record-user" });
    await user.see({ testId: "audit-record-assistant" });
    expect(await probe.hash()).toBe(routeBefore);
    evidence.recordAssertionEvidence(
      "The inline Audit trail projects the completed task without changing the route",
      "The real mocked-provider turn produces user and assistant rows in the panel while the active session hash remains unchanged.",
      true,
    );
  });

  await step("selecting a record opens its safe detail dialog", async () => {
    await user.click({ testId: "audit-record-assistant" });
    await user.see({ text: "Status" });
    await user.see({ text: "Model" });
    await user.press("Escape");
    await user.notSee({ text: "Status" });
  });

  await step("refresh preserves the panel and Export audit trail creates deterministic JSON metadata", async () => {
    await user.click({ role: "button", label: "Refresh audit trail" });
    await user.see({ testId: "audit-trail-panel" });

    await probe.eval(() => {
      window.__auditExportBlob = undefined;
      window.__auditExportFilename = undefined;
      URL.createObjectURL = (value: Blob) => {
        window.__auditExportBlob = value;
        return "blob:audit-test";
      };
      HTMLAnchorElement.prototype.click = function click() {
        window.__auditExportFilename = this.download;
      };
    });
    await user.click({ role: "button", label: "Export audit trail" });
    const exported = await probe.eventually(() => probe.eval(async () => {
      const blob = window.__auditExportBlob;
      return blob ? { filename: window.__auditExportFilename ?? "", json: await blob.text() } : null;
    }, { awaitPromise: true }), {
      within: 5_000,
      label: "audit export blob created",
      until: (value) => value !== null,
    });

    expect(exported?.filename).toBe("audit-trail.json");
    const payload = JSON.parse(exported?.json ?? "null") as {
      schemaVersion?: number;
      partialHistory?: boolean;
      records?: unknown[];
    };
    expect(payload.schemaVersion).toBe(1);
    expect(typeof payload.partialHistory).toBe("boolean");
    expect(payload.records?.length).toBeGreaterThanOrEqual(2);
    expect(exported?.json).not.toContain("sk-audit-streamed-markdown");
    evidence.recordAssertionEvidence(
      "Audit export contains the projected records without provider credentials",
      `The ${exported?.filename} download contains schemaVersion 1, an explicit partialHistory flag, and ${payload.records?.length ?? 0} records; the configured provider key is absent.`,
      true,
    );
  });
});
