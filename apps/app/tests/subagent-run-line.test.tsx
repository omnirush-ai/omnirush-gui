import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { SubagentRunLine, subagentRunActivity } from "../src/components/chat/subagent-run-line";
import type { TaskToolPart } from "../src/lib/build-in-tools";

const noop = () => {};

function taskPart(state: "input-streaming" | "output-available", childSessionId?: string): TaskToolPart {
  const input = {
    description: "Build isolated Azure repro",
    prompt: "Reproduce the Azure failure in isolation.",
    subagent_type: "executor-deep",
  };

  const callProviderMetadata = childSessionId ? { omnirush: { childSessionId } } : undefined;

  return state === "output-available"
    ? {
        type: "dynamic-tool",
        toolName: "task",
        toolCallId: "call-subagent",
        state,
        input,
        output: "Completed the reproduction.",
        callProviderMetadata,
      }
    : {
        type: "dynamic-tool",
        toolName: "task",
        toolCallId: "call-subagent",
        state,
        input,
        callProviderMetadata,
      };
}

function render(part: TaskToolPart): string {
  return renderToStaticMarkup(
    <MessageListProvider
      workspaceId="workspace-a"
      sessionId="session-origin"
      showThinking={false}
      developerMode={false}
      displaySuggestions={false}
      providerConnectedCount={1}
      dispatchAction={noop}
      setPrompt={noop}
      onRevertToUserMessage={noop}
      onForkAtMessage={noop}
      onEditUserMessage={noop}
      onMcpReconnect={async () => "connected"}
      onMcpReopenAuthorization={async () => {}}
      onMcpRetry={noop}
    >
      <SubagentRunLine part={part} />
    </MessageListProvider>,
  );
}

describe("SubagentRunLine", () => {
  test("uses a text shimmer instead of a spinner while the subagent is running", () => {
    const html = render(taskPart("input-streaming"));

    expect(html).toContain('data-subagent-activity="shimmer"');
    expect(html).toContain("ow-text-shimmer");
    expect(html).toContain("Build isolated Azure repro");
    expect(html).toContain("Working 0s");
    expect(html).not.toContain("animate-spin");
  });

  test("settles to a static completed treatment", () => {
    const html = render(taskPart("output-available"));

    expect(html).toContain('data-subagent-activity="completed"');
    expect(html).toContain("Completed");
    expect(html).not.toContain("ow-text-shimmer");
    expect(html).not.toContain("animate-spin");
  });

  test("prioritizes a blocked permission over the running treatment", () => {
    expect(subagentRunActivity({
      permissionPending: true,
      inFlight: true,
      failed: false,
    })).toBe("waiting-permission");
  });

  test("keeps a blocked permission ahead of a lost connection, which only downgrades the running treatment", () => {
    expect(subagentRunActivity({
      permissionPending: true,
      syncDegraded: true,
      inFlight: true,
      failed: false,
    })).toBe("waiting-permission");
    expect(subagentRunActivity({
      permissionPending: false,
      syncDegraded: true,
      inFlight: true,
      failed: false,
    })).toBe("reconnecting");
  });

  test("silence is not completion and cannot replace waiting, retrying, or disconnected status", () => {
    const input = { permissionPending: false, inFlight: true, failed: false, noNewActivity: true };
    expect(subagentRunActivity(input)).toBe("no-new-activity");
    expect(subagentRunActivity({ ...input, questionPending: true })).toBe("waiting-question");
    expect(subagentRunActivity({ ...input, retrying: true })).toBe("retrying");
    expect(subagentRunActivity({ ...input, syncDegraded: true })).toBe("reconnecting");
    expect(subagentRunActivity({ ...input, inFlight: false })).toBe("completed");
  });

  test("a finished task names the sub-agent's model, and a fallback to the main model", () => {
    const part = taskPart("output-available", "ses_child");
    part.callProviderMetadata = { omnirush: { childSessionId: "ses_child", subagentModel: "gpt-6-sol" } };
    const html = render(part);
    expect(html).toContain('data-subagent-model="gpt-6-sol"');
    expect(html).toContain("GPT 6 Sol");

    const fellBack = taskPart("output-available", "ses_child");
    fellBack.callProviderMetadata = {
      omnirush: { childSessionId: "ses_child", subagentModel: "gpt-6-astra", subagentModelFallback: { requested: "meta-muse-spark", used: "gpt-6-astra", reason: "refused" } },
    };
    const fallbackHtml = render(fellBack);
    expect(fallbackHtml).toContain('data-subagent-model-fallback="meta-muse-spark"');
    expect(fallbackHtml).toContain("GPT 6 Astra (Meta Muse Spark unavailable)");

    // While the task runs nothing is claimed: the engine's start-time model is only a guess.
    const running = taskPart("input-streaming", "ses_child");
    running.callProviderMetadata = { omnirush: { childSessionId: "ses_child", subagentModel: "gpt-6-sol" } };
    expect(render(running)).not.toContain("data-subagent-model");
  });
});
