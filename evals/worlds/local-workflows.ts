import { configureProvider } from "./chat.ts";
import type { Seed } from "@omnirush/env";

/**
 * A hermetic local-first workflow workspace. The provider is the deterministic
 * OpenAI-compatible mock shipped with the eval labs; no real credentials or
 * network model are involved.
 */
export async function localWorkflows(seed: Seed) {
  const providerId = "workflow-routing-mock";
  const generalModelId = "workflow-general";
  const codingModelId = "workflow-coding";
  const gatherMarker = "LOCAL_WORKFLOW_GATHER";
  const findingsMarker = "LOCAL_WORKFLOW_FINDINGS";
  const mock = seed.mock({
    agentWorkloads: [
      {
        promptMarker: gatherMarker,
        finalReply: findingsMarker,
        steps: [],
      },
      {
        promptMarker: findingsMarker,
        finalReply: "WORKFLOW_PLAN_COMPLETE",
        steps: [],
      },
    ],
  });
  const den = await seed.den({ mocks: { agent: mock } });
  const app = await seed.desktop({ den, as: "admin", model: `${providerId}/${generalModelId}`, name: "local-workflows" });
  const workspace = await seed.workspace(app, seed.tmpPath("local-workflows"));
  await configureProvider(seed, app, workspace.workspaceId, providerId, generalModelId, {
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Workflow routing mock",
        options: { baseURL: `${den.mocks.agent.url}/v1`, apiKey: "sk-workflow-routing" },
        models: {
          [generalModelId]: { name: "Workflow General" },
          [codingModelId]: { name: "Workflow Coding" },
        },
      },
    },
  });
  // The single-session seed fires rename without waiting for it to settle.
  // Use the verified helper before the journey starts interacting with the UI.
  const [session] = await seed.sessions(app, ["Local workflow proof"]);
  return {
    app,
    den,
    workspace,
    session,
    mock: den.mocks.agent,
    providerId,
    generalModelId,
    codingModelId,
    gatherMarker,
    findingsMarker,
  };
}
