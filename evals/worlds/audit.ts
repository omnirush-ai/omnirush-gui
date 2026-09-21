import { configureProvider } from "./chat.ts";
import { streamedMarkdownAnswer, streamedMarkdownMarker, streamedMarkdownReasoning } from "./chat.ts";
import type { Seed } from "@omnirush/env";

export async function auditMarkdown(seed: Seed) {
  const providerId = "audit-streamed-markdown-mock";
  const modelId = "audit-streamed-markdown-model";
  const mock = seed.mock({
    agentWorkloads: [{
      promptMarker: streamedMarkdownMarker,
      finalReply: streamedMarkdownAnswer,
      finalReasoning: streamedMarkdownReasoning,
      finalReplyChunkSize: null,
      steps: [],
    }],
  });
  const den = await seed.den({ mocks: { agent: mock } });
  const app = await seed.desktop({ den, as: "admin", model: `${providerId}/${modelId}` });
  const workspace = await seed.workspace(app, seed.tmpPath("audit-streamed-markdown"));
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Audit streamed markdown mock",
        options: { baseURL: `${den.mocks.agent.url}/v1`, apiKey: "sk-audit-streamed-markdown" },
        models: { [modelId]: { name: "Audit streamed markdown model", reasoning: true } },
      },
    },
  });
  const [session] = await seed.sessions(app, ["Audit trail proof"]);
  return { app, den, workspace, session, mock: den.mocks.agent };
}
