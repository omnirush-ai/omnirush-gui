import { expect } from "vitest";
import { spec } from "@omnirush/testkit";
import { localWorkflows } from "../worlds/local-workflows.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected object");
  return value;
}

function array(value: unknown, key: string): Record<string, unknown>[] {
  const result = record(value)[key];
  if (!Array.isArray(result)) throw new Error(`Expected ${key} array`);
  return result.map(record);
}

const test = spec.world(localWorkflows, { timeout: 600_000, needs: { placement: "local" } });

test("local model routing and workflow automation complete a run with traceable history", async ({ world, user, probe, step, evidence }) => {
  const endpoint = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/local-workflows`;
  const readState = async () => {
    const result = await probe.desktopApi(endpoint);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return record(result.body);
  };
  const chooseModel = async (testId: string, modelId: string) => {
    await user.click({ testId });
    await user.click({ testId: `${testId}-option-${world.providerId}/${modelId}` });
  };
  const waitForRun = async (workflowId: string, trigger: "manual" | "schedule", within: number) => {
    const settled = await probe.eventually(readState, {
      within,
      label: `${trigger} workflow run reaches a terminal status`,
      until: (state) => array(state, "runs").some((run) => run.workflowId === workflowId && run.trigger === trigger && run.status !== "running"),
    });
    const run = array(settled, "runs").find((item) => item.workflowId === workflowId && item.trigger === trigger && item.status !== "running");
    if (!run || typeof run.id !== "string") throw new Error("Terminal run missing");
    expect(run.status, JSON.stringify({ error: run.error, steps: run.steps })).toBe("completed");
    return run;
  };

  await step("save routing rules and preview without running a workflow", async () => {
    await user.see({ text: world.session.title }, { timeoutMs: 60_000 });
    await user.click({ testId: "local-workflows-toggle" });
    await user.see({ testId: "local-workflows-panel" });
    await user.click({ role: "tab", label: "Model routing" });
    await chooseModel("routing-default-model", world.generalModelId);
    await chooseModel("routing-category-coding", world.codingModelId);
    await user.click({ testId: "routing-save" });
    await user.see({ text: "Routing settings saved." });
    await user.type({ testId: "routing-preview-prompt" }, "Implement a TypeScript function", { replace: true });
    await user.click({ testId: "routing-preview-submit" });
    await user.see({ testId: "routing-preview-result" }, { text: /workflow-routing-mock \/ workflow-coding/ });
    const state = await readState();
    const routing = record(state.routing);
    expect(routing.enabled).toBe(true);
    expect(routing.defaultModel).toEqual({ providerID: world.providerId, modelID: world.generalModelId });
    expect(record(routing.categories).coding).toEqual({ providerID: world.providerId, modelID: world.codingModelId });
    expect(array(state, "runs")).toEqual([]);
    expect(await world.mock.agentRequests()).toEqual([]);
    evidence.recordAssertionEvidence(
      "Routing saves a general default and a coding rule; preview is side-effect-free",
      `The panel previews ${world.codingModelId} for a coding prompt after saving ${world.generalModelId} as the default. No workflow runs or provider requests were created by preview.`,
      true,
    );
  });

  let workflowId = "";
  await step("create and enable a saved workflow", async () => {
    await user.click({ role: "tab", label: "Workflows" });
    await user.click({ testId: "workflow-add-template" });
    await user.type({ testId: "workflow-name" }, "Local briefing automation", { replace: true });
    await user.type({ testId: "workflow-interval" }, "1440", { replace: true });
    await user.type({ testId: "workflow-step-prompt-0" }, world.gatherMarker, { replace: true });
    await user.type({ testId: "workflow-step-prompt-1" }, "Implement a code plan from the previous step: {{previous}}", { replace: true });
    for (const index of [0, 1]) {
      await user.click({ testId: `workflow-step-category-${index}` });
      await user.click({ testId: `workflow-step-category-${index}-option-auto` });
    }
    await user.click({ testId: "workflow-save" });
    await user.see({ text: "Workflow saved." });
    const state = await readState();
    const workflows = array(state, "workflows");
    const workflow = workflows.find((item) => item.name === "Local briefing automation");
    if (!workflow || typeof workflow.id !== "string") throw new Error("Saved workflow was not returned by local server");
    workflowId = workflow.id;
    expect(array(workflow, "steps").map((item) => item.category)).toEqual(["auto", "auto"]);
    await user.click({ testId: `workflow-toggle-${workflowId}` });
    await user.see({ testId: `workflow-toggle-${workflowId}` }, { text: "Pause schedule" });
    const enabled = array(await readState(), "workflows").find((item) => item.id === workflowId);
    expect(enabled?.enabled).toBe(true);
    expect(enabled?.intervalMinutes).toBe(1440);
    expect(typeof enabled?.nextRunAt).toBe("number");
    evidence.recordAssertionEvidence(
      "A workflow can be saved and enabled for local scheduling",
      `The saved workflow ${workflowId} is present in the local snapshot and its enabled flag becomes true after the trusted toggle action.`,
      true,
    );
  });

  await step("run it and inspect completed step history", async () => {
    await user.click({ testId: `workflow-run-${workflowId}` });
    const run = await waitForRun(workflowId, "manual", 120_000);
    const steps = array(run, "steps");
    expect(steps).toHaveLength(2);
    expect(steps.every((item) => item.status === "completed")).toBe(true);
    expect(steps.every((item) => typeof item.sessionId === "string" && item.sessionId.length > 0)).toBe(true);
    expect(steps.map((item) => record(record(item.decision).model).modelID)).toEqual([world.generalModelId, world.codingModelId]);
    expect(steps.map((item) => item.output)).toEqual([world.findingsMarker, "WORKFLOW_PLAN_COMPLETE"]);
    expect(new Set(steps.map((item) => item.sessionId)).size).toBe(2);
    const requests = await world.mock.agentRequests();
    expect(requests.filter((request) => request.kind === "final").map((request) => [request.promptMarker, request.model])).toEqual([
      [world.gatherMarker, world.generalModelId],
      [world.findingsMarker, world.codingModelId],
    ]);
    await user.click({ role: "tab", label: "Run history" });
    await user.see({ testId: `workflow-run-detail-${run.id}` }, { text: /completed|WORKFLOW_PLAN_COMPLETE|session/i });
    await user.click({ testId: `workflow-run-detail-${run.id}` });
    for (const [index, item] of steps.entries()) {
      await user.see({ testId: `workflow-run-step-${item.stepId}` }, { text: index === 0 ? /Model: workflow-routing-mock \/ workflow-general/ : /Model: workflow-routing-mock \/ workflow-coding/ });
      await user.see({ testId: `workflow-run-session-${item.stepId}` }, { text: "Open session" });
    }
    await user.click({ text: "Show output", nth: 1 });
    await user.see({ text: "WORKFLOW_PLAN_COMPLETE" });
    evidence.recordAssertionEvidence(
      "Workflow history exposes completion, routed model, session IDs, and output",
      `Run ${run.id} completed two distinct sessions using the general then coding model. The mock received the first output in step two; history renders both resolved models and the final output.`,
      true,
    );
  });

  await step("pause scheduling without deleting history", async () => {
    await user.click({ role: "tab", label: "Workflows" });
    await user.click({ testId: `workflow-toggle-${workflowId}` });
    await user.see({ testId: `workflow-toggle-${workflowId}` }, { text: "Enable schedule" });
    const paused = await readState();
    const workflow = array(paused, "workflows").find((item) => item.id === workflowId);
    expect(workflow?.enabled).toBe(false);
    expect(workflow?.nextRunAt).toBeNull();
    expect(array(paused, "runs")).toHaveLength(1);
    evidence.recordAssertionEvidence(
      "Pausing automation preserves its saved workflow and run history",
      "The workflow enabled flag becomes false while the completed run remains in the local snapshot.",
      true,
    );
  });

  await step("an interval schedule starts a real run without clicking Run now", async () => {
    await user.click({ testId: `workflow-edit-${workflowId}` });
    await user.type({ testId: "workflow-interval" }, "1", { replace: true });
    await user.click({ testId: "workflow-save" });
    await user.see({ text: "Workflow saved." });
    expect(array(await readState(), "runs")).toHaveLength(1);
    await user.click({ testId: `workflow-toggle-${workflowId}` });
    await user.see({ testId: `workflow-toggle-${workflowId}` }, { text: "Pause schedule" });
    const scheduled = await waitForRun(workflowId, "schedule", 120_000);
    const steps = array(scheduled, "steps");
    expect(steps).toHaveLength(2);
    expect(steps.map((item) => item.output)).toEqual([world.findingsMarker, "WORKFLOW_PLAN_COMPLETE"]);
    expect(steps.map((item) => record(record(item.decision).model).modelID)).toEqual([world.generalModelId, world.codingModelId]);
    await user.click({ testId: `workflow-toggle-${workflowId}` });
    await user.see({ testId: `workflow-toggle-${workflowId}` }, { text: "Enable schedule" });
    const paused = await readState();
    expect(array(paused, "workflows").find((item) => item.id === workflowId)?.nextRunAt).toBeNull();
    expect(array(paused, "runs")).toHaveLength(2);
    expect((await world.mock.agentRequests()).filter((request) => request.kind === "final").map((request) => [request.promptMarker, request.model])).toEqual([
      [world.gatherMarker, world.generalModelId],
      [world.findingsMarker, world.codingModelId],
      [world.gatherMarker, world.generalModelId],
      [world.findingsMarker, world.codingModelId],
    ]);
    await user.click({ role: "tab", label: "Run history" });
    await user.see({ testId: `workflow-run-detail-${scheduled.id}` }, { text: /schedule/ });
    await user.see({ testId: `workflow-run-status-${scheduled.id}` }, { text: /^completed$/i });
    const audit = await probe.desktopApi(`/workspace/${encodeURIComponent(world.workspace.workspaceId)}/audit?limit=50`);
    expect(audit.status).toBe(200);
    const auditEntries = array(audit.body, "items");
    const completedRuns = array(paused, "runs");
    for (const run of completedRuns) {
      expect(auditEntries.some((entry) => entry.target === run.id && entry.action === "local_workflow.run.started")).toBe(true);
      expect(auditEntries.some((entry) => entry.target === run.id && entry.action === "local_workflow.run.completed")).toBe(true);
    }
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "A saved interval automation runs through both routed models without a manual Run now action",
      `After changing the saved interval to one minute and enabling the schedule, run ${scheduled.id} completed with trigger schedule and both expected outputs. Four provider requests cover one manual and one scheduled run; pausing clears the next due time and preserves both history records. Each run has started and completed audit events.`,
      true,
    );
  });
});
