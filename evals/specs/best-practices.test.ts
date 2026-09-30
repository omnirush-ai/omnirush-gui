import { spec } from "@omnirush/testkit";
import { expect } from "vitest";
import {
  bestPractices, bestPracticesAttached, BEST_PRACTICES_HEADING, BUNDLED_SKILLS, MOCK_REPLY, PRIVATE_CANARY, USER_SKILL,
} from "../worlds/best-practices.ts";

const test = spec.world(bestPractices, { needs: { commands: ["bun"], placement: "local" }, timeout: 240_000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skillNames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Expected the real engine's skill catalog.");
  return value.filter(isRecord).map((skill) => typeof skill.name === "string" ? skill.name : "");
}

function replyText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.parts)) return "";
  return value.parts.filter(isRecord).map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "").join("");
}

test("Best practices default on, toggle only the bundled guides, and survive a real server restart", { timeout: 480_000 }, async ({ world, probe, step, evidence }) => {
  try {
  const originalFiles = await world.snapshot();
  await step("only authenticated clients can read or change the typed setting", async () => {
    expect((await world.config("GET", undefined, false)).status).toBe(401);
    expect((await world.config("PUT", { enabled: false }, false)).status).toBe(401);
    for (const body of [{}, { enabled: "false" }, { enabled: false, other: true }]) {
      expect((await world.config("PUT", body)).status).toBe(400);
    }
    expect(await world.config("GET")).toEqual({ status: 200, body: { enabled: true } });
    expect(world.requests).toHaveLength(0);
    evidence.recordAssertionEvidence("The setting defaults on and rejects anonymous or malformed changes", "Authenticated GET returned enabled=true. Anonymous GET/PUT returned 401. Missing, non-boolean, and extra fields returned 400 without changing the saved state or making model calls.", true);
  });

  await step("the actual native engine advertises built-in, user, and swarm skills", async () => {
    const names = await probe.eventually(async () => skillNames(await world.engine("GET", "/skill")), {
      within: 30_000, intervalMs: 250, label: "real engine best-practices catalog",
      until: (names) => BUNDLED_SKILLS.every((name) => names.includes(name)) && names.includes(USER_SKILL),
    });
    expect(names).toEqual(expect.arrayContaining([...BUNDLED_SKILLS, USER_SKILL, "omnirush-swarm"]));
    const before = world.requests.length;
    expect(replyText(await world.send("Reply with a short acknowledgement. Do not use tools."))).toBe(MOCK_REPLY);
    expect(world.requests.slice(before)).toHaveLength(1);
    const request = world.requests.at(-1);
    expect(request?.body.includes(BEST_PRACTICES_HEADING)).toBe(true);
    expect(request?.body.includes(USER_SKILL)).toBe(true);
    expect(request?.body.includes("omnirush-swarm")).toBe(true);
    for (const name of BUNDLED_SKILLS) expect(request?.body.includes(name)).toBe(true);
    expect(request?.body.includes(PRIVATE_CANARY)).toBe(false);
    evidence.recordAssertionEvidence("The real engine's outgoing request includes the short guide prompt and native catalog", "The engine listed all nine bundled skills plus the user-owned guide and omnirush-swarm. One requested model turn carried the Best practices heading and skill names, and returned the deterministic reply without private canary content.", true);
  });

  await step("off removes the bundled prompt and catalog without a model request or project edit", async () => {
    const before = world.requests.length;
    expect(await world.config("PUT", { enabled: false })).toEqual({ status: 200, body: {
      ok: true, enabled: false, changed: true, engine: { status: "applied" },
    } });
    const names = await probe.eventually(async () => skillNames(await world.engine("GET", "/skill")), {
      within: 30_000, intervalMs: 250, label: "disabled real engine best-practices catalog",
      until: (names) => BUNDLED_SKILLS.every((name) => !names.includes(name)),
    });
    for (const name of BUNDLED_SKILLS) expect(names).not.toContain(name);
    expect(names).toEqual(expect.arrayContaining([USER_SKILL, "omnirush-swarm"]));
    expect(world.requests).toHaveLength(before);
    expect(await world.snapshot()).toEqual(originalFiles);
    expect(replyText(await world.send("Reply with another short acknowledgement. Do not use tools."))).toBe(MOCK_REPLY);
    expect(world.requests.slice(before)).toHaveLength(1);
    const request = world.requests.at(-1);
    expect(request?.body.includes(BEST_PRACTICES_HEADING)).toBe(false);
    for (const name of BUNDLED_SKILLS) expect(request?.body.includes(name)).toBe(false);
    expect(request?.body.includes(USER_SKILL)).toBe(true);
    expect(request?.body.includes("omnirush-swarm")).toBe(true);
    evidence.recordAssertionEvidence("Off removes only the bundled guidance for subsequent engine requests", "PUT returned applied. All nine bundled names and the Best practices heading disappeared from the next real-engine model request while user and swarm skills remained. The toggle made zero model calls and changed no project files.", true);
  });

  await step("the saved off choice survives restart, and on restores the guides", async () => {
    const before = world.requests.length;
    await world.restart();
    expect(await world.config("GET")).toEqual({ status: 200, body: { enabled: false } });
    const restartedNames = await probe.eventually(async () => skillNames(await world.engine("GET", "/skill")), {
      within: 30_000, intervalMs: 250, label: "preserved user and swarm catalog after cold restart",
      until: (names) => names.includes(USER_SKILL) && names.includes("omnirush-swarm"),
    });
    for (const name of BUNDLED_SKILLS) expect(restartedNames).not.toContain(name);
    expect(restartedNames).toEqual(expect.arrayContaining([USER_SKILL, "omnirush-swarm"]));
    expect(world.requests).toHaveLength(before);
    expect(await world.config("PUT", { enabled: true })).toEqual({ status: 200, body: {
      ok: true, enabled: true, changed: true, engine: { status: "applied" },
    } });
    await probe.eventually(async () => skillNames(await world.engine("GET", "/skill")), {
      within: 30_000, intervalMs: 250, label: "restored real engine best-practices catalog",
      until: (names) => BUNDLED_SKILLS.every((name) => names.includes(name)),
    });
    expect(world.requests).toHaveLength(before);
    expect(replyText(await world.send("Reply with a final short acknowledgement. Do not use tools."))).toBe(MOCK_REPLY);
    expect(world.requests.slice(before)).toHaveLength(1);
    expect(world.requests.at(-1)?.body.includes(BEST_PRACTICES_HEADING)).toBe(true);
    for (const name of BUNDLED_SKILLS) expect(world.requests.at(-1)?.body.includes(name)).toBe(true);
    expect(await world.snapshot()).toEqual(originalFiles);
    expect(world.requests.some((request) => request.body.includes(PRIVATE_CANARY))).toBe(false);
    evidence.recordAssertionEvidence("The saved choice survives restart and on restores guidance without leaking fixture inputs", "After a cold process restart, GET still reported off and the real engine kept only user and swarm skills. On restored all nine names and the short prompt. Toggling and restarting made no model calls; all original project bytes, including the private canary, stayed unchanged and the canary never reached the mock provider.", true);
  });
  } finally {
    evidence.recordJsonArtifact("server diagnostics and model request witnesses", {
      output: world.output().replaceAll(world.token, "<fixture-client>").replaceAll(world.workspace, "<fixture-workspace>"),
      requests: world.requests.map((request) => ({
        path: request.path, completed: request.completed, closedBeforeReply: request.closedBeforeReply,
        guidancePresent: request.body.includes(BEST_PRACTICES_HEADING),
        bundledSkills: BUNDLED_SKILLS.filter((name) => request.body.includes(name)),
        userSkillPresent: request.body.includes(USER_SKILL), swarmPresent: request.body.includes("omnirush-swarm"),
        privateCanaryPresent: request.body.includes(PRIVATE_CANARY),
      })),
    });
  }
});

test("changing Best practices keeps an active real engine reply intact", { timeout: 300_000 }, async ({ world, probe, step, evidence }) => {
  try {
  await step("an in-flight model reply completes while the next request uses the saved choice", async () => {
    const originalFiles = await world.snapshot();
    const waiting = world.holdNextReply();
    const running = world.send("Keep this acknowledgement pending until the witness releases it. Do not use tools.");
    void running.catch(() => undefined);
    const held = await probe.eventually(() => Promise.race([
      waiting,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250)),
    ]), { within: 30_000, intervalMs: 100, label: "in-flight real model request", until: (value) => value !== undefined });
    if (!held) throw new Error("The model request did not reach the witness.");
    try {
      expect(held.request.body.includes(BEST_PRACTICES_HEADING)).toBe(true);
      const before = world.requests.length;
      expect(await world.config("PUT", { enabled: false })).toEqual({ status: 200, body: {
        ok: true, enabled: false, changed: true, engine: { status: "applied" },
      } });
      expect(held.request.closedBeforeReply).toBe(false);
      expect(held.request.completed).toBe(false);
      expect(world.requests).toHaveLength(before);
      held.release();
      expect(replyText(await running)).toBe(MOCK_REPLY);
      expect(held.request.closedBeforeReply).toBe(false);
      expect(world.requests).toHaveLength(before);
      expect(replyText(await world.send("Acknowledge the next request. Do not use tools."))).toBe(MOCK_REPLY);
      expect(world.requests).toHaveLength(before + 1);
      expect(world.requests.at(-1)?.body.includes(BEST_PRACTICES_HEADING)).toBe(false);
      for (const name of BUNDLED_SKILLS) expect(world.requests.at(-1)?.body.includes(name)).toBe(false);
      expect(world.requests.at(-1)?.body.includes(USER_SKILL)).toBe(true);
      expect(world.requests.at(-1)?.body.includes("omnirush-swarm")).toBe(true);
      expect(await world.snapshot()).toEqual(originalFiles);
      expect(world.requests.some((request) => request.body.includes(PRIVATE_CANARY))).toBe(false);
      evidence.recordAssertionEvidence("Toggling does not cancel active work or trigger an extra model request", "A real-engine reply was held at the loopback provider. Turning off returned applied while its connection stayed open; it then completed with the expected reply. Only the next user-requested turn omitted the guidance. No project bytes changed and no canary content reached the provider.", true);
    } finally {
      held.release();
      await running.catch(() => undefined);
    }
  });
  } finally {
    evidence.recordJsonArtifact("active reply diagnostics and model request witnesses", {
      output: world.output().replaceAll(world.token, "<fixture-client>").replaceAll(world.workspace, "<fixture-workspace>"),
      requests: world.requests.map((request) => ({
        path: request.path, completed: request.completed, closedBeforeReply: request.closedBeforeReply,
        guidancePresent: request.body.includes(BEST_PRACTICES_HEADING), privateCanaryPresent: request.body.includes(PRIVATE_CANARY),
        bundledSkills: BUNDLED_SKILLS.filter((name) => request.body.includes(name)),
        userSkillPresent: request.body.includes(USER_SKILL), swarmPresent: request.body.includes("omnirush-swarm"),
      })),
    });
  }
});

const attachedTest = spec.world(bestPracticesAttached, { needs: { commands: ["bun"], placement: "local" }, timeout: 90_000 });

attachedTest("Best practices saves busy attached-engine changes and reports apply failure honestly", { timeout: 120_000 }, async ({ world, probe, step, evidence }) => {
  const originalFiles = await world.snapshot();
  await step("busy work is not disposed, and the saved choice applies once the engine becomes idle", async () => {
    world.requests.length = 0;
    expect(await world.config("PUT", { enabled: false })).toEqual({ status: 200, body: {
      ok: true, enabled: false, changed: true, engine: { status: "deferred" },
    } });
    expect(world.requests).not.toContain("POST /instance/dispose");
    expect(world.requests.some((request) => request.endsWith("/abort"))).toBe(false);
    expect(await world.config("GET")).toEqual({ status: 200, body: { enabled: false } });
    world.setBehavior("idle");
    await probe.eventually(() => world.requests.filter((request) => request === "POST /instance/dispose").length, {
      within: 10_000, intervalMs: 100, label: "deferred attached engine reload after idle", until: (count) => count === 1,
    });
    expect(world.requests.filter((request) => request === "POST /instance/dispose")).toHaveLength(1);
    expect(world.requests.some((request) => request.endsWith("/abort"))).toBe(false);
    expect(world.requests.some((request) => request.includes("/message"))).toBe(false);
    expect(await world.snapshot()).toEqual(originalFiles);
    evidence.recordAssertionEvidence("A busy attached engine is deferred without aborting work and retries at idle", "The real server returned deferred, persisted off, sent no dispose or abort while busy, then disposed exactly once after the witness became idle. No model-message calls or project edits occurred.", true);
  });

  await step("a failed engine apply retains the saved choice without claiming success", async () => {
    world.setBehavior("failed");
    world.requests.length = 0;
    expect(await world.config("PUT", { enabled: true })).toEqual({ status: 200, body: {
      ok: true, enabled: true, changed: true, engine: { status: "failed" },
    } });
    expect(await world.config("GET")).toEqual({ status: 200, body: { enabled: true } });
    expect(world.requests).toContain("POST /instance/dispose");
    expect(world.requests.some((request) => request.endsWith("/abort"))).toBe(false);
    expect(world.requests.some((request) => request.includes("/message"))).toBe(false);
    expect(await world.snapshot()).toEqual(originalFiles);
    evidence.recordAssertionEvidence("A reload failure is reported separately from the saved choice", "The attached witness rejected reload with HTTP 500. The real server returned engine.status=failed, and subsequent GET still returned enabled=true. It made no abort or model-message request and preserved project bytes.", true);
  });
});
