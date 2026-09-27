import { expect } from "vitest";
import { spec } from "@omnirush/testkit";
import { modelReasoningSummary, REPLY, SUMMARY } from "../worlds/model-reasoning-summary.ts";

const test = spec.world(modelReasoningSummary, { needs: { commands: ["bun"] }, timeout: 240_000 });
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("Astra and Sol deliver requested reasoning summaries through the desktop broker into persisted engine messages", async ({ world, step, evidence }) => {
  for (const modelID of ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol"]) {
    await step(`reasoning remains available after switching to ${modelID}`, async () => {
      const session = await world.engine("POST", "/session", { title: "Summary verification" });
      if (!record(session) || typeof session.id !== "string") throw new Error("Missing session id");
      const before = world.requests.length;
      const result = await world.engine("POST", `/session/${session.id}/message`, {
        model: { providerID: "omnirush", modelID }, variant: "high",
        parts: [{ type: "text", text: "Compute 17 plus 25." }],
      });
      expect(record(result) && record(result.info) && result.info.error).toBeUndefined();
      if (!record(result) || !Array.isArray(result.parts)) throw new Error("Missing reply parts");
      expect(result.parts.filter(record).filter((part) => part.type === "reasoning")).toEqual([
        expect.objectContaining({ text: SUMMARY }),
      ]);
      expect(result.parts.filter(record).filter((part) => part.type === "text")).toEqual([
        expect.objectContaining({ text: REPLY }),
      ]);
      const requests = world.requests.slice(before);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ path: "/v1/responses", body: { model: modelID, reasoning: { effort: "high", summary: "auto" } },
        headers: { authorization: "Bearer summary-witness-access" } });
      expect(requests[0]?.headers["x-omnirush-reasoning-effort"]).toBeUndefined();
      const persisted = await world.engine("GET", `/session/${session.id}/message`);
      if (!Array.isArray(persisted)) throw new Error("Missing persisted messages");
      const assistant = persisted.filter(record).find((message) => record(message.info) && message.info.role === "assistant");
      expect(assistant).toMatchObject({ parts: expect.arrayContaining([expect.objectContaining({ type: "reasoning", text: SUMMARY })]) });
    });
  }

  await step("explicit settings, other models and compaction retain their request options", async () => {
    const bodies = [
      { model: "gpt-6-astra", input: "defaults" },
      { model: "gpt-6-sol", input: "explicit", reasoning: { effort: "low", summary: "detailed" } },
      { model: "gpt-6-astra", input: "disabled", reasoning: { summary: null } },
      { model: "gpt-5.6-sol", input: "no-default" },
      { model: "other-model", input: "unrelated" },
    ];
    const before = world.requests.length;
    for (const body of bodies) expect((await world.gateway(body)).status).toBe(200);
    const compact = { model: "gpt-6-astra", input: "compact", reasoning: { effort: "high" } };
    expect((await world.gateway(compact, "responses/compact")).status).toBe(200);
    expect(world.requests.slice(before).map((request) => request.body)).toEqual([
      { ...bodies[0], reasoning: { summary: "auto" } }, ...bodies.slice(1), compact,
    ]);
  });

  await step("a subagent fallback requests the destination Astra summary", async () => {
    const before = world.requests.length;
    expect((await world.gateway({ model: "unavailable-model", input: "fallback" }, "responses", {
      "x-omnirush-subagent-fallback-model": "gpt-6-astra",
      "x-omnirush-subagent-fallback-effort": "max",
    })).status).toBe(200);
    expect(world.requests.slice(before).map((request) => request.body)).toEqual([
      { model: "unavailable-model", input: "fallback" },
      { model: "gpt-6-astra", input: "fallback", reasoning: { effort: "max", summary: "auto" } },
    ]);
  });
  evidence.recordAssertionEvidence("GPT-6 summary opt-in reaches the transcript data", "The real embedded desktop server and bundled OpenCode engine send exactly one high-effort summary-enabled request for Astra, GPT 6 Sol and GPT-5.6 Sol; each returned and persisted a reasoning part plus the answer. The provider witness emits summary events only when explicitly requested.", true);
  evidence.recordAssertionEvidence("Request settings and routing remain scoped", "Observable gateway requests preserve explicit detailed and null summary values, leave other model IDs and compact requests unchanged, strip the private effort header, and add the summary after a subagent switches from an unrelated model to Astra.", true);
});
