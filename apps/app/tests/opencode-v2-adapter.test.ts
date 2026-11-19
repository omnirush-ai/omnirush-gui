import { describe, expect, test } from "bun:test";

import {
  createClientV2,
  createV2EventTranslationState,
  translateV2Event,
} from "../src/app/lib/opencode-v2-adapter";
import { parseDynamicToolUIPart } from "../src/react-app/domains/session/sync/parse-tool-parts";
import { codeModeToolCalls } from "../src/lib/code-mode-tools";

const capturedPermissionAsked = {
  id: "evt_permission_asked",
  created: 1_788_548_737_221,
  type: "permission.asked",
  location: { directory: "/workspace" },
  data: {
    id: "per_child",
    sessionID: "ses_child",
    action: "shell",
    resources: ["printf 'TOOL_RESULT_OK'"],
    save: ["printf *"],
    source: { type: "tool", messageID: "msg_child", id: "call_child" },
    message: "Allow this command?",
  },
  durable: { aggregateID: "ses_child", seq: 8, version: 1 },
};

const capturedPermissionReplied = {
  id: "evt_permission_replied",
  created: 1_788_548_737_260,
  type: "permission.replied",
  location: { directory: "/workspace" },
  data: { sessionID: "ses_child", requestID: "per_child", reply: "once" },
};

// Native beta-19086 fork schema: ancestry is not the new session's parentID.
const nativeForkEvent = {
  type: "session.forked",
  created: 1_788_548_737_221,
  location: { directory: "/workspace" },
  data: { sessionID: "ses_fork", parentID: "ses_source", boundary: { type: "through", messageID: "msg_source" } },
};

// Captured from 0.0.0-beta-19086 after approving one shell call with `once`.
const capturedV2ToolMessage = {
  id: "msg_06e0e76b900178zSuF55n4XEPY",
  time: {
    created: 1_788_552_837_299,
    streamed: 1_788_552_838_056,
    completed: 1_788_552_838_186,
  },
  type: "assistant",
  agent: "omnirush",
  model: { id: "model", providerID: "witness", variant: "default" },
  content: [
    { type: "text", text: "Running the shell.\n" },
    {
      type: "tool",
      id: "call_captured_shell",
      name: "shell",
      executed: false,
      state: {
        status: "completed",
        input: { command: "printf 'TOOL_RESULT_OK\\n'", timeout: 30_000 },
        content: [
          { type: "text", text: "TOOL_RESULT_OK\n" },
          { type: "text", text: "Command exited with code 0." },
        ],
        metadata: { status: "completed", truncated: false, exit: 0 },
      },
      time: {
        created: 1_788_552_837_549,
        ran: 1_788_552_838_052,
        completed: 1_788_552_838_184,
      },
    },
  ],
  finish: "tool-calls",
  rawFinish: "tool_calls",
  cost: 0,
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
};

const capturedV2ToolEvents = [
  {
    id: "evt_06e0e79ad001BAvTZOqueGcqPa",
    created: 1_788_552_837_549,
    type: "session.tool.input.started",
    data: {
      sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
      assistantMessageID: "msg_06e0e76b900178zSuF55n4XEPY",
      id: "call_captured_shell",
      name: "shell",
    },
  },
  {
    id: "evt_06e0e7ba3001XQZt8DvOc8VTE1",
    created: 1_788_552_838_051,
    type: "session.tool.input.ended",
    data: {
      sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
      assistantMessageID: "msg_06e0e76b900178zSuF55n4XEPY",
      id: "call_captured_shell",
      text: "{\"command\":\"printf 'TOOL_RESULT_OK\\\\n'\",\"timeout\":30000}",
    },
  },
  {
    id: "evt_06e0e7ba4001XebEvHlJDSttDY",
    created: 1_788_552_838_052,
    type: "session.tool.called",
    data: {
      sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
      assistantMessageID: "msg_06e0e76b900178zSuF55n4XEPY",
      id: "call_captured_shell",
      input: { command: "printf 'TOOL_RESULT_OK\\n'", timeout: 30_000 },
      executed: false,
    },
  },
  {
    id: "evt_06e0e7c22002P2HdF8g7Jt5EGX",
    created: 1_788_552_838_178,
    type: "session.tool.progress",
    data: {
      sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
      assistantMessageID: "msg_06e0e76b900178zSuF55n4XEPY",
      id: "call_captured_shell",
      metadata: { shellID: "sh_06e0e7c1e0017KTSezeFHBiGRk" },
    },
  },
  {
    id: "evt_06e0e7c28001BsHlyKVTMaacIe",
    created: 1_788_552_838_184,
    type: "session.tool.success",
    data: {
      sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
      assistantMessageID: "msg_06e0e76b900178zSuF55n4XEPY",
      id: "call_captured_shell",
      content: [
        { type: "text", text: "TOOL_RESULT_OK\n" },
        { type: "text", text: "Command exited with code 0." },
      ],
      metadata: { status: "completed", truncated: false, exit: 0 },
      executed: false,
    },
  },
];

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function eventStream() {
  let send = (..._events: unknown[]) => {};
  let close = () => {};
  let fail = (_error: Error) => {};
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      send = (...events) => controller.enqueue(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
      close = () => controller.close();
      fail = (error) => controller.error(error);
    },
    cancel() { cancelled = true; },
  });
  return { response: new Response(body), send, close, fail, body, get cancelled() { return cancelled; } };
}

describe("OpenCode v2 event translation", () => {
  test("preserves native retry detail and sequenced interruption reasons without claiming success", () => {
    const state = createV2EventTranslationState();
    expect(translateV2Event({ type: "session.retry.scheduled", durable: { seq: 12 }, data: {
      sessionID: "s", assistantMessageID: "m", attempt: 3, at: 10_000, error: { message: "Rate limited" },
    } }, state)).toEqual([{ type: "session.status", properties: {
      sessionID: "s", sequence: 12, status: { type: "retry", attempt: 3, message: "Rate limited", next: 10_000 },
    } }]);
    for (const reason of ["user", "shutdown", "superseded", "future-reason"]) {
      expect(translateV2Event({ type: "session.execution.interrupted", durable: { seq: 13 },
        data: { sessionID: "s", reason } }, state)).toEqual([{
        type: "session.execution.interrupted", properties: { sessionID: "s", reason, sequence: 13 },
      }]);
    }
    expect(translateV2Event({ type: "session.step.started", durable: { seq: 14 }, data: { sessionID: "s" } }, state))
      .toEqual([{ type: "session.execution.progress", properties: { sessionID: "s", sequence: 14 } }]);
  });
  test("renders an admitted user message before execution using its persisted identity", () => {
    const state = createV2EventTranslationState();
    const admitted = {
      type: "session.inbox.enqueued",
      created: 1_788_657_600_000,
      location: { directory: "/workspace" },
      data: {
        sessionID: "ses_upgrade",
        inboxID: "msg_user",
        item: { type: "user", payload: { text: "hi" }, delivery: "steer" },
      },
    };
    const expected = [
      { type: "message.updated", properties: { info: {
        id: "msg_user", sessionID: "ses_upgrade", role: "user", time: { created: admitted.created },
      } } },
      { type: "message.part.updated", properties: { part: {
        id: "msg_user:0", messageID: "msg_user", sessionID: "ses_upgrade", type: "text", text: "hi",
      } } },
    ];
    expect(translateV2Event(admitted, state)).toEqual(expected);
    // A replay must update the same message and part, not create another row.
    expect(translateV2Event(admitted, state)).toEqual(expected);
    expect(translateV2Event({
      type: "session.inbox.cancelled", data: { sessionID: "ses_upgrade", inboxID: "msg_user" },
    }, state)).toEqual([
      { type: "message.removed", properties: { sessionID: "ses_upgrade", messageID: "msg_user" } },
    ]);
    expect(translateV2Event({ ...admitted, data: {
      ...admitted.data, item: { type: "synthetic", payload: { text: "Internal instructions" }, delivery: "steer" },
    } }, state)).toBeNull();
  });

  test("uses the created envelope timestamp for an untitled session", () => {
    const created = 1_788_548_737_221;
    const event = {
      type: "session.created",
      created,
      location: { directory: "/workspace" },
      data: { sessionID: "ses_new" },
    };

    expect(translateV2Event(event, createV2EventTranslationState())).toEqual([{
      type: "session.created",
      properties: {
        info: {
          id: "ses_new",
          slug: "ses_new",
          projectID: "v2",
          directory: "/workspace",
          title: `New session - ${new Date(created).toISOString()}`,
          version: "v2",
          time: { created, updated: created },
        },
      },
    }]);
    expect(event.data).toEqual({ sessionID: "ses_new" });
  });

  test.each(["Named session", "Untitled session", ""])("translates rename %j as a title-only patch", (title) => {
    expect(translateV2Event({
      type: "session.renamed",
      created: 1_788_548_737_260,
      location: { directory: "/workspace" },
      data: { sessionID: "ses_named", title },
    }, createV2EventTranslationState())).toEqual([{
      type: "session.updated",
      properties: { info: { id: "ses_named", title } },
    }]);
  });

  test("does not turn an incomplete rename into a generated title", () => {
    expect(translateV2Event({
      type: "session.renamed",
      data: { sessionID: "ses_named" },
    }, createV2EventTranslationState())).toBeNull();
  });

  test("uses one stable text part id from start through the cumulative end update", () => {
    const state = createV2EventTranslationState();

    expect(translateV2Event({
      type: "session.text.started",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        textID: "txt_1",
        timestamp: 10,
      },
    }, state)).toEqual([
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_1",
            sessionID: "ses_1",
            role: "assistant",
            time: { created: 10 },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "msg_1:0",
            messageID: "msg_1",
            sessionID: "ses_1",
            type: "text",
            text: "",
          },
        },
      },
    ]);

    expect(translateV2Event({
      type: "session.text.delta",
      data: { sessionID: "ses_1", textID: "txt_1", delta: "Hello " },
    }, state)).toEqual([{
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "msg_1:0",
        field: "text",
        delta: "Hello ",
      },
    }]);
    translateV2Event({
      type: "session.text.delta",
      data: { sessionID: "ses_1", textID: "txt_1", delta: "world" },
    }, state);

    expect(translateV2Event({
      type: "session.text.ended",
      data: { sessionID: "ses_1", textID: "txt_1" },
    }, state)).toEqual([{
      type: "message.part.updated",
      properties: {
        part: {
          id: "msg_1:0",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          text: "Hello world",
        },
      },
    }]);
  });

  test("uses event-provided ordinals to keep same-message text parts distinct", () => {
    const state = createV2EventTranslationState();

    const firstStarted = translateV2Event({
      type: "session.text.started",
      data: { sessionID: "ses_ordinal", assistantMessageID: "msg_ordinal", ordinal: 0 },
    }, state);
    const secondStarted = translateV2Event({
      type: "session.text.started",
      data: { sessionID: "ses_ordinal", assistantMessageID: "msg_ordinal", ordinal: 1 },
    }, state);

    expect(firstStarted?.[1]).toMatchObject({
      type: "message.part.updated",
      properties: { part: { id: "msg_ordinal:0" } },
    });
    expect(secondStarted?.[1]).toMatchObject({
      type: "message.part.updated",
      properties: { part: { id: "msg_ordinal:1" } },
    });

    const delta = translateV2Event({
      type: "session.text.delta",
      data: { sessionID: "ses_ordinal", assistantMessageID: "msg_ordinal", ordinal: 1, delta: "second" },
    }, state);
    expect(delta).toEqual([{
      type: "message.part.delta",
      properties: {
        sessionID: "ses_ordinal",
        messageID: "msg_ordinal",
        partID: "msg_ordinal:1",
        field: "text",
        delta: "second",
      },
    }]);
    expect(delta).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ properties: expect.objectContaining({ partID: "msg_ordinal:0" }) }),
    ]));
  });

  test("translates captured v2 text lifecycle events through explicit execution success", () => {
    const state = createV2EventTranslationState();
    const captured = [
      { type: "session.text.started", data: { sessionID: "s", assistantMessageID: "m", ordinal: 0 } },
      { type: "session.text.delta", data: { sessionID: "s", assistantMessageID: "m", ordinal: 0, delta: "hello world" } },
      { type: "session.text.ended", data: { sessionID: "s", assistantMessageID: "m", ordinal: 0, text: "hello world" } },
      { type: "session.execution.succeeded", data: { sessionID: "s" } },
    ];
    const translated = captured.flatMap((event) => translateV2Event(event, state) ?? []);

    expect(translated).toEqual([
      {
        type: "message.updated",
        properties: {
          info: {
            id: "m",
            sessionID: "s",
            role: "assistant",
            time: { created: expect.any(Number) },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { id: "m:0", messageID: "m", sessionID: "s", type: "text", text: "" },
        },
      },
      {
        type: "message.part.delta",
        properties: {
          sessionID: "s",
          messageID: "m",
          partID: "m:0",
          field: "text",
          delta: "hello world",
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { id: "m:0", messageID: "m", sessionID: "s", type: "text", text: "hello world" },
        },
      },
      { type: "session.execution.succeeded", properties: { sessionID: "s", sequence: undefined } },
    ]);
  });

  test("translates the captured v2 shell lifecycle using the bash presentation", () => {
    const state = createV2EventTranslationState();
    const translated = capturedV2ToolEvents.flatMap((event) => translateV2Event(event, state) ?? []);
    const command = { command: "printf 'TOOL_RESULT_OK\\n'", timeout: 30_000 };

    expect(translated).toEqual([
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_06e0e76b900178zSuF55n4XEPY",
            sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
            role: "assistant",
            time: { created: 1_788_552_837_549 },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "call_captured_shell",
            messageID: "msg_06e0e76b900178zSuF55n4XEPY",
            sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
            type: "tool",
            callID: "call_captured_shell",
            tool: "bash",
            state: { status: "pending", input: {}, raw: "" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: expect.objectContaining({
            id: "call_captured_shell",
            state: {
              status: "pending",
              input: command,
              raw: "{\"command\":\"printf 'TOOL_RESULT_OK\\\\n'\",\"timeout\":30000}",
            },
          }),
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: expect.objectContaining({
            id: "call_captured_shell",
            state: {
              status: "running",
              input: command,
              title: "bash",
              metadata: {},
              time: { start: 1_788_552_838_052 },
            },
          }),
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: expect.objectContaining({
            id: "call_captured_shell",
            state: {
              status: "running",
              input: command,
              title: "bash",
              metadata: { shellID: "sh_06e0e7c1e0017KTSezeFHBiGRk" },
              time: { start: 1_788_552_838_052 },
            },
          }),
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "call_captured_shell",
            messageID: "msg_06e0e76b900178zSuF55n4XEPY",
            sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
            type: "tool",
            callID: "call_captured_shell",
            tool: "bash",
            state: {
              status: "completed",
              input: command,
              output: "TOOL_RESULT_OK\n\nCommand exited with code 0.",
              title: "bash",
              metadata: { status: "completed", truncated: false, exit: 0 },
              time: { start: 1_788_552_838_052, end: 1_788_552_838_184 },
            },
          },
        },
      },
    ]);
  });

  test.each(["text", "reasoning"])("isolates %s streams by session, message, kind, and ordinal", (kind) => {
    const state = createV2EventTranslationState();
    for (const sessionID of ["ses_one", "ses_two"]) {
      for (const assistantMessageID of ["msg_one", "msg_two"]) {
        for (const streamKind of ["text", "reasoning"]) {
          translateV2Event({
            type: `session.${streamKind}.started`, created: 10,
            data: { sessionID, assistantMessageID, ordinal: 0 },
          }, state);
        }
      }
    }
    const identity = { sessionID: "ses_one", assistantMessageID: "msg_one", ordinal: 0 };
    const id = kind === "text" ? "msg_one:0" : "msg_one:reasoning:0";
    expect(translateV2Event({
      type: `session.${kind}.delta`, data: { ...identity, delta: "only this part" },
    }, state)).toEqual([{
      type: "message.part.delta",
      properties: { sessionID: "ses_one", messageID: "msg_one", partID: id, field: "text", delta: "only this part" },
    }]);
    for (const unmatched of [
      { ...identity, assistantMessageID: "msg_missing" },
      { ...identity, ordinal: 9 },
      { ...identity, sessionID: "ses_missing" },
      { sessionID: "ses_one", [`${kind}ID`]: "missing" },
      { sessionID: "ses_one", [`${kind}Id`]: "missing" },
      { sessionID: "ses_one", assistantMessageID: "msg_one" },
      { sessionID: "ses_one", assistantMessageID: "" },
      { sessionID: "ses_one", messageID: null },
    ]) {
      expect(translateV2Event({ type: `session.${kind}.delta`, data: { ...unmatched, delta: "WRONG" } }, state)).toBeNull();
      expect(translateV2Event({ type: `session.${kind}.ended`, data: { ...unmatched, text: "WRONG" } }, state)).toBeNull();
    }
    for (const sessionID of ["ses_one", "ses_two"]) {
      for (const assistantMessageID of ["msg_one", "msg_two"]) {
        for (const streamKind of ["text", "reasoning"]) {
          expect(translateV2Event({
            type: `session.${streamKind}.ended`, created: 20,
            data: { sessionID, assistantMessageID, ordinal: 0 },
          }, state)).toMatchObject([{
            properties: { part: {
              sessionID, messageID: assistantMessageID, type: streamKind,
              text: sessionID === "ses_one" && assistantMessageID === "msg_one" && streamKind === kind ? "only this part" : "",
            } },
          }]);
        }
      }
    }
  });

  test("keeps legacy aliases and kind-local counters without letting tools consume text ordinals", () => {
    const state = createV2EventTranslationState();
    const identity = { sessionID: "ses_legacy", assistantMessageID: "msg_legacy" };
    translateV2Event({ type: "session.tool.input.started", data: { ...identity, id: "call_first", name: "shell" } }, state);
    for (const ordinal of [0, 1]) {
      for (const kind of ["reasoning", "text"]) {
        const id = `msg_legacy:${kind === "reasoning" ? "reasoning:" : ""}${ordinal}`;
        const started = {
          type: `session.next.${kind}.started`, created: 10,
          data: { ...identity, [`${kind}ID`]: `shared_${ordinal}` },
        };
        expect(translateV2Event(started, state)?.[1]).toMatchObject({ properties: { part: { id, text: "" } } });
        translateV2Event({ type: `session.next.${kind}.delta`, data: { sessionID: identity.sessionID, delta: "legacy" } }, state);
        // Replayed starts must not reset accumulated text or advance the counter.
        expect(translateV2Event(started, state)?.[1]).toMatchObject({ properties: { part: { id, text: "legacy" } } });
        expect(translateV2Event({
          type: `session.next.${kind}.ended`, created: 20,
          data: { sessionID: identity.sessionID, [`${kind}ID`]: `shared_${ordinal}` },
        }, state)).toMatchObject([{ properties: { part: { id, text: "legacy" } } }]);
        expect(translateV2Event({
          type: `session.next.${kind}.delta`,
          data: { ...identity, assistantMessageID: "msg_other", [`${kind}ID`]: `shared_${ordinal}`, delta: "WRONG" },
        }, state)).toBeNull();
        expect(translateV2Event({
          type: `session.next.${kind}.delta`,
          data: { ...identity, ordinal: 9, [`${kind}ID`]: `shared_${ordinal}`, delta: "WRONG" },
        }, state)).toBeNull();
      }
    }
  });

  test("preserves execution failure for sequenced terminal handling", () => {
    const state = createV2EventTranslationState();
    expect(translateV2Event({
      type: "session.execution.failed",
      properties: { sessionID: "ses_2", error: { message: "provider failed" } },
    }, state)).toEqual([
      {
        type: "session.execution.failed",
        properties: {
          sessionID: "ses_2",
          sequence: undefined,
          error: { name: "UnknownError", data: { message: "provider failed" } },
        },
      },
    ]);
  });

  test("a failed execution keeps the provider's HTTP status for the auto retry", () => {
    expect(translateV2Event({
      type: "session.execution.failed",
      properties: { sessionID: "ses_2", error: { type: "provider.invalid-request", message: "This chat runs on gpt-6-astra.", status: 400 } },
    }, createV2EventTranslationState())?.[0]?.properties).toMatchObject({
      error: { name: "UnknownError", data: { message: "This chat runs on gpt-6-astra.", statusCode: 400 } },
    });
  });

  test("a bare gateway code reads as the broker's copy, an unknown one keeps the code in a plain line", () => {
    // As engine v2 sends them (rig capture): the gateway's code is the whole message.
    const busy = { type: "provider.internal", message: "no_channel_available", status: 503, response: { body: "{\"detail\":\"no_channel_available\"}" } };
    expect(translateV2Event({ type: "session.retry.scheduled", data: { sessionID: "s", assistantMessageID: "m", attempt: 3, at: 10_000, error: busy } },
      createV2EventTranslationState())?.[0]?.properties).toMatchObject({
      status: { type: "retry", message: "omnirush.ai: this model is busy right now. Try again in a moment." },
    });
    expect(translateV2Event({ type: "session.retry.scheduled", data: { sessionID: "s", assistantMessageID: "m", attempt: 1, at: 10_000, error: { ...busy, message: "upstream_gateway_overload" } } },
      createV2EventTranslationState())?.[0]?.properties).toMatchObject({
      status: { message: "omnirush.ai: this model is busy right now. Try again in a moment." },
    });
    expect(translateV2Event({
      type: "session.execution.failed",
      properties: { sessionID: "ses_2", error: { type: "provider.invalid-request", message: "some_new_gateway_code", status: 400 } },
    }, createV2EventTranslationState())?.[0]?.properties).toMatchObject({
      error: { name: "UnknownError", data: { message: "omnirush.ai could not complete the model request (some_new_gateway_code).", code: "some_new_gateway_code", statusCode: 400 } },
    });
    // Words stay as they are.
    expect(translateV2Event({ type: "session.retry.scheduled", data: { sessionID: "s", attempt: 2, at: 1, error: { message: "Rate limited" } } },
      createV2EventTranslationState())?.[0]?.properties).toMatchObject({ status: { message: "Rate limited" } });
  });

  test("a one-word gateway code from the shared table reads as its copy too", () => {
    const failed = (message: string) => translateV2Event({
      type: "session.execution.failed",
      properties: { sessionID: "ses_2", error: { type: "provider.internal", message, status: 503 } },
    }, createV2EventTranslationState())?.[0]?.properties;
    const unavailable = "omnirush.ai: this model is temporarily unavailable. Try again in a minute, or pick another model.";
    for (const code of ["maintenance", "draining", "upstream_maintenance"]) {
      expect(failed(code)).toMatchObject({ error: { data: { message: unavailable, code, statusCode: 503 } } });
    }
    // A one-word message the table does not know stays as sent, and so do Object's own names.
    for (const word of ["overloaded", "constructor", "toString"]) {
      expect(failed(word)).toMatchObject({ error: { data: { message: word } } });
      expect((failed(word) as { error: { data: Record<string, unknown> } }).error.data.code).toBeUndefined();
    }
  });

  test("a snake_case error on another provider's message keeps its own words", async () => {
    const originalFetch = globalThis.fetch;
    const turn = (providerID: string) => ({
      id: `msg_${providerID}`, type: "assistant", time: { created: 1, completed: 2 },
      model: { id: "model", providerID }, error: { type: "provider.invalid-request", message: "context_length_exceeded", status: 400 }, content: [],
    });
    globalThis.fetch = async () => jsonResponse({ data: [turn("openai"), turn("omnirush")] });
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.messages({ sessionID: "ses_other" });
      expect(Object.fromEntries(result.data?.map((message) => [message.info.id, message.info.error]) ?? [])).toEqual({
        msg_openai: { name: "UnknownError", data: { message: "context_length_exceeded", statusCode: 400 } },
        msg_omnirush: { name: "UnknownError", data: { message: "omnirush.ai could not complete the model request (context_length_exceeded).", code: "context_length_exceeded", statusCode: 400 } },
      });
    } finally { globalThis.fetch = originalFetch; }
  });

  test("translates captured permission events for the child session while preserving busy and idle", () => {
    const state = createV2EventTranslationState();
    const translated = [
      { type: "session.execution.started", data: { sessionID: "ses_child" } },
      capturedPermissionAsked,
      capturedPermissionReplied,
      { type: "session.execution.succeeded", data: { sessionID: "ses_child" } },
    ].flatMap((event) => translateV2Event(event, state) ?? []);

    expect(translated).toEqual([
      { type: "session.execution.started", properties: { sessionID: "ses_child", sequence: undefined } },
      {
        type: "permission.asked",
        properties: {
          id: "per_child",
          sessionID: "ses_child",
          action: "shell",
          resources: ["printf 'TOOL_RESULT_OK'"],
          save: ["printf *"],
          metadata: { message: "Allow this command?" },
          source: { type: "tool", messageID: "msg_child", callID: "call_child" },
        },
      },
      {
        type: "permission.replied",
        properties: { sessionID: "ses_child", requestID: "per_child", reply: "once" },
      },
      { type: "session.execution.succeeded", properties: { sessionID: "ses_child", sequence: undefined } },
    ]);
  });
});

describe("OpenCode v2 client compatibility", () => {
  test.each([0, 1_788_548_737_221])("archives (archived=%i) through the server's own flag on the session PATCH", async (archived) => {
    const originalFetch = globalThis.fetch;
    const sent: Array<{ method: string; path: string; body: unknown }> = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      sent.push({ method: request.method, path: new URL(request.url).pathname, body: request.method === "PATCH" ? await request.json() : null });
      return jsonResponse({ data: { id: "ses_archive", title: "Keep", time: { created: 1, ...(archived ? { archived } : {}) } } });
    };
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.update({ sessionID: "ses_archive", title: "Renamed", time: { archived } });
      expect(result.data?.time.archived).toBe(archived || undefined);
      expect(sent[0]).toEqual({ method: "PATCH", path: "/opencode2/api/session/ses_archive", body: { title: "Renamed", archived: archived || null } });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([true, false])("returns the actual native interrupt acknowledgement %s", async (interrupted) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      expect(input instanceof Request && input.url.endsWith("/api/session/s/interrupt")).toBe(true);
      return jsonResponse({ interrupted });
    };
    try {
      expect((await createClientV2("http://opencode.test/opencode2", undefined, {}).session.abort({ sessionID: "s" })).data)
        .toBe(interrupted);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("rejects a malformed native interrupt acknowledgement", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({ data: {} });
    try {
      const result = await createClientV2("http://opencode.test/opencode2", undefined, {}).session.abort({ sessionID: "s" });
      expect(result.data).toBeUndefined();
      expect(result.error).toEqual({ name: "InvalidV2InterruptResponse" });
    } finally { globalThis.fetch = originalFetch; }
  });

  test("saved native instruction updates stay out of the visible conversation", async () => {
    const originalFetch = globalThis.fetch;
    const notice = "New skills are available in addition to those previously listed.";
    globalThis.fetch = async () => jsonResponse({ data: [
      { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 6 } },
      { id: "msg_switch", type: "model-switched", model: { id: "m", providerID: "p" }, time: { created: 5 } },
      { id: "msg_answer", type: "assistant", content: [{ type: "text", text: "The current report code." }], time: { created: 4 } },
      { id: "msg_user", type: "user", text: notice, time: { created: 3 } },
      { id: "msg_synthetic", type: "synthetic", text: "Internal context", time: { created: 2 } },
      { id: "msg_system", type: "system", text: notice, time: { created: 1 } },
    ] });
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.messages({ sessionID: "ses_skills" });
      expect(result.data?.map(message => message.info.id)).toEqual(["msg_user", "msg_answer"]);
      expect(result.data?.[0]?.parts).toMatchObject([{ type: "text", text: notice }]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("Code Mode keeps the same child identities through progress, replay, and saved history", async () => {
    const state = createV2EventTranslationState();
    const data = { sessionID: "ses_code", assistantMessageID: "msg_code", id: "execute-code" };
    const toolCalls = [
      { tool: "omnirush-cloud.search_capabilities", status: "completed", input: { query: "Slack" } },
      { tool: "omnirush-cloud.execute_capability", status: "running", input: { name: "mcp:connection:list_channels" } },
    ];
    translateV2Event({ type: "session.tool.input.started", data: { ...data, name: "execute" } }, state);
    translateV2Event({ type: "session.tool.called", data: { ...data, input: { code: "recorded code" } } }, state);
    const progress = { type: "session.tool.progress", data: { ...data, metadata: { toolCalls } } };
    const expected = [{ type: "message.part.updated", properties: { part: {
      id: "execute-code", callID: "execute-code", tool: "execute", metadata: { omnirushV2CodeMode: true },
      state: { status: "running", metadata: { toolCalls } },
    } } }];
    expect(translateV2Event(progress, state)).toMatchObject(expected);
    expect(translateV2Event(progress, state)).toMatchObject(expected);
    const completedCalls = toolCalls.map(call => ({ ...call, status: "completed" }));
    expect(translateV2Event({ type: "session.tool.success", data: {
      ...data, metadata: { toolCalls: completedCalls }, content: [{ type: "text", text: "Combined result" }],
    } }, state)).toMatchObject([{ properties: { part: { id: "execute-code", state: {
      output: "Combined result", metadata: { toolCalls: completedCalls },
    } } } }]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({ data: [{
      id: "msg_code", type: "assistant", time: { created: 1, completed: 2 },
      content: [{ id: "execute-code", type: "tool", name: "execute", time: { created: 1, completed: 2 }, state: {
        status: "completed", input: { code: "recorded code" }, metadata: { toolCalls: completedCalls },
        content: [{ type: "text", text: "Combined result" }],
      } }],
    }] });
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.messages({ sessionID: "ses_code" });
      const saved = result.data?.[0]?.parts[0];
      if (saved?.type !== "tool") throw new Error("Missing saved execute part");
      const ui = parseDynamicToolUIPart(saved);
      if (!ui) throw new Error("Missing execute UI part");
      expect(codeModeToolCalls(ui)?.map(call => [call.toolCallId, call.toolName, call.state])).toEqual([
        ["execute-code:call:0", "omnirush-cloud_search_capabilities", "output-available"],
        ["execute-code:call:1", "omnirush-cloud_execute_capability", "output-available"],
      ]);
      expect(ui).toMatchObject({ output: "Combined result" });
    } finally { globalThis.fetch = originalFetch; }
  });
  test("hydrates mixed native content with the same text and reasoning IDs as streaming", async () => {
    const originalFetch = globalThis.fetch;
    // beta19086 schema: each kind has its own ordinal; reasoning time is optional.
    const message = {
      id: "msg_mixed", type: "assistant", time: { created: 5, completed: 90 },
      error: { type: "unknown", message: "partial turn failed" },
      content: [
        { type: "reasoning", text: "First thought", time: { created: 10, completed: 20 } },
        { ...capturedV2ToolMessage.content[1] },
        { type: "text", text: "First answer" },
        { type: "reasoning", text: "Second thought", time: { created: 40, completed: 50 } },
        { type: "text", text: "Second answer" },
        { type: "reasoning", text: "Unfinished thought" },
      ],
    };
    globalThis.fetch = async () => jsonResponse({ data: [message] });
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.messages({ sessionID: "ses_mixed" });
      const parts = result.data?.[0]?.parts;
      expect(parts?.map((part) => part.id)).toEqual([
        "msg_mixed:reasoning:0", "call_captured_shell", "msg_mixed:0",
        "msg_mixed:reasoning:1", "msg_mixed:1", "msg_mixed:reasoning:2",
      ]);
      expect(result.data?.[0]?.info.error).toEqual({ name: "UnknownError", data: { message: "partial turn failed" } });
      expect(parts?.[5]).toEqual({
        id: "msg_mixed:reasoning:2", sessionID: "ses_mixed", messageID: "msg_mixed",
        type: "reasoning", text: "Unfinished thought", time: { start: 5 },
      });
      const state = createV2EventTranslationState();
      const identity = { sessionID: "ses_mixed", assistantMessageID: "msg_mixed" };
      translateV2Event({ type: "session.tool.input.started", data: { ...identity, id: "call_captured_shell", name: "shell" } }, state);
      for (const [kind, ordinal, text, start, end, index] of [
        ["reasoning", 0, "First thought", 10, 20, 0],
        ["text", 0, "First answer", 30, 35, 2],
        ["reasoning", 1, "Second thought", 40, 50, 3],
        ["text", 1, "Second answer", 60, 70, 4],
      ] as const) {
        const data = { ...identity, ordinal };
        const started = translateV2Event({ type: `session.${kind}.started`, created: start, data }, state);
        expect(started?.[0]).toMatchObject({ properties: { info: { time: { created: start } } } });
        expect(started?.[1]).toMatchObject({ properties: { part: { id: parts?.[index]?.id, type: kind, text: "" } } });
        translateV2Event({ type: `session.${kind}.delta`, data: { ...data, delta: "partial" } }, state);
        const ended = { type: `session.${kind}.ended`, created: end, data: { ...data, text } };
        expect(translateV2Event(ended, state)).toEqual([{ type: "message.part.updated", properties: { part: parts?.[index] } }]);
        expect(translateV2Event(ended, state)).toEqual([{ type: "message.part.updated", properties: { part: parts?.[index] } }]);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps native file results to stable per-call attachments in live and hydrated completed tools", async () => {
    const originalFetch = globalThis.fetch;
    const content = [
      { type: "text", text: "Created files" },
      { type: "file", uri: "file:///workspace/report.pdf", mime: "application/pdf", name: "report.pdf" },
      { type: "text", text: "Two outputs" },
      { type: "file", uri: "data:image/png;base64,AA==", mime: "image/png" },
    ];
    const tools = ["call_one", "call_two"].map((id) => ({
      type: "tool", id, name: "export_report",
      state: { status: "completed", input: {}, content, metadata: { files: 2 } },
      time: { created: 10, ran: 20, completed: 30 },
    }));
    globalThis.fetch = async () => jsonResponse({ data: [{ id: "msg_files", type: "assistant", time: { created: 5 }, content: tools }] });
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.messages({ sessionID: "ses_files" });
      const state = createV2EventTranslationState();
      for (const [index, tool] of tools.entries()) {
        const identity = { sessionID: "ses_files", assistantMessageID: "msg_files", id: tool.id };
        translateV2Event({ type: "session.tool.input.started", created: 10, data: { ...identity, name: tool.name } }, state);
        translateV2Event({ type: "session.tool.called", created: 20, data: { ...identity, input: {}, executed: false } }, state);
        const completed = translateV2Event({
          type: "session.tool.success", created: 30, data: { ...identity, content, metadata: { files: 2 }, executed: false },
        }, state);
        expect(completed).toEqual([{ type: "message.part.updated", properties: { part: result.data?.[0]?.parts[index] } }]);
        expect(result.data?.[0]?.parts[index]).toMatchObject({ state: {
          output: "Created files\nTwo outputs",
          attachments: [
            { id: `${tool.id}:file:0`, sessionID: "ses_files", messageID: "msg_files", type: "file", url: content[1]?.uri, mime: "application/pdf", filename: "report.pdf" },
            { id: `${tool.id}:file:1`, sessionID: "ses_files", messageID: "msg_files", type: "file", url: content[3]?.uri, mime: "image/png" },
          ],
        } });
        // Repeated completion retains IDs, including identical URIs on distinct calls.
        expect(translateV2Event({
          type: "session.tool.success", created: 30, data: { ...identity, content },
        }, state)).toEqual(completed);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each(["subagent", "task", "custom_subagent"])("normalizes only native subagent fields, not %s lookalikes", async (name) => {
    const originalFetch = globalThis.fetch;
    const input = { agent: "explore", prompt: "Inspect workspace", description: "Workspace inspection", extra: { keep: true } };
    const metadata = { sessionID: "ses_child", status: "working", extra: ["keep"] };
    const expectedInput = name === "subagent" ? { ...input, subagent_type: "explore" } : input;
    const expectedMetadata = name === "subagent" ? { ...metadata, sessionId: "ses_child" } : metadata;
    const expectedTool = name === "subagent" ? "task" : name;
    const error = { type: "unknown", message: "child failed" };
    const content = [{ type: "text", text: "Child result" }];
    const states = [
      { status: "streaming", input: JSON.stringify(input) },
      { status: "running", input, metadata },
      { status: "completed", input, metadata, content },
      { status: "error", input, metadata, error },
    ];
    globalThis.fetch = async () => jsonResponse({ data: states.map((state) => ({
      id: "msg_parent", type: "assistant", time: { created: 5 },
      content: [{ type: "tool", id: "call_child", name, state, time: { created: 10, ran: 20, completed: 30 } }],
    })).reverse() });
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.messages({ sessionID: "ses_parent" });
      for (const [index, message] of (result.data ?? []).entries()) {
        expect(message.parts[0]).toMatchObject({
          tool: expectedTool, state: { input: expectedInput, ...(index > 0 ? { metadata: expectedMetadata } : {}) },
        });
      }
      const state = createV2EventTranslationState();
      const identity = { sessionID: "ses_parent", assistantMessageID: "msg_parent", id: "call_child" };
      translateV2Event({ type: "session.tool.input.started", created: 10, data: { ...identity, name } }, state);
      for (const type of ["session.tool.input.delta", "session.tool.input.ended"]) {
        expect(translateV2Event({ type, data: { ...identity, delta: JSON.stringify(input), text: JSON.stringify(input) } }, state))
          .toEqual([{ type: "message.part.updated", properties: { part: result.data?.[0]?.parts[0] } }]);
      }
      expect(translateV2Event({ type: "session.tool.called", created: 20, data: { ...identity, input, executed: false } }, state))
        .toMatchObject([{ properties: { part: { tool: expectedTool, state: { input: expectedInput, status: "running" } } } }]);
      expect(translateV2Event({ type: "session.tool.progress", created: 25, data: { ...identity, metadata } }, state))
        .toEqual([{ type: "message.part.updated", properties: { part: result.data?.[1]?.parts[0] } }]);
      expect(translateV2Event({ type: "session.tool.success", created: 30, data: { ...identity, metadata, content, executed: false } }, state))
        .toEqual([{ type: "message.part.updated", properties: { part: result.data?.[2]?.parts[0] } }]);
      expect(translateV2Event({ type: "session.tool.failed", created: 30, data: { ...identity, metadata, error, executed: false } }, state))
        .toEqual([{ type: "message.part.updated", properties: { part: result.data?.[3]?.parts[0] } }]);
      expect(result.data?.[3]?.parts[0]).toMatchObject({ state: { error: "child failed" } });
      expect(input).not.toHaveProperty("subagent_type");
      expect(metadata).not.toHaveProperty("sessionId");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves existing compatibility fields on native subagent inputs and metadata", async () => {
    const originalFetch = globalThis.fetch;
    const input = { agent: "explore", subagent_type: "manual", custom: { agent: "unchanged" } };
    const metadata = { sessionID: "ses_native", sessionId: "ses_manual", custom: { sessionID: "unchanged" } };
    globalThis.fetch = async () => jsonResponse({ data: [{
      id: "msg_parent", type: "assistant", time: { created: 10 },
      content: [{ type: "tool", id: "call_child", name: "subagent", time: { created: 10, ran: 20 }, state: { status: "running", input, metadata } }],
    }] });
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.messages({ sessionID: "ses_parent" });
      expect(result.data?.[0]?.parts[0]).toMatchObject({ tool: "task", state: { input, metadata } });
      const state = createV2EventTranslationState();
      const identity = { sessionID: "ses_parent", assistantMessageID: "msg_parent", id: "call_child" };
      translateV2Event({ type: "session.tool.input.started", created: 10, data: { ...identity, name: "subagent" } }, state);
      translateV2Event({ type: "session.tool.called", created: 20, data: { ...identity, input, executed: false } }, state);
      expect(translateV2Event({ type: "session.tool.progress", data: { ...identity, metadata } }, state))
        .toEqual([{ type: "message.part.updated", properties: { part: result.data?.[0]?.parts[0] } }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps only missing and empty native titles to stable read-time placeholders", async () => {
    const originalFetch = globalThis.fetch;
    const created = 1_788_548_737_221;
    const time = { created, updated: created + 100 };
    const sessions = [
      { id: "ses_missing", created },
      { id: "ses_empty", title: "", time },
      { id: "ses_literal", title: "Untitled session", time },
      { id: "ses_named", title: "Named session", time },
    ];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET" && request.url.endsWith("/api/session")) {
        return jsonResponse({ data: sessions });
      }
      const session = sessions.find((item) => request.url.endsWith(`/api/session/${item.id}`));
      if (request.method === "GET" && session) return jsonResponse({ data: session });
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.list();
      const placeholder = `New session - ${new Date(created).toISOString()}`;
      expect(result.data?.map((session) => session.title)).toEqual([
        placeholder, placeholder, "Untitled session", "Named session",
      ]);
      for (const session of result.data ?? []) {
        const fetched = await client.session.get({ sessionID: session.id });
        expect(fetched.data).toEqual(session);
      }
      expect(result.data?.[1]?.time).toEqual(time);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([undefined, "", "Named session", "Untitled session"])("forwards only the provided title %j when creating a session", async (title) => {
    const originalFetch = globalThis.fetch;
    const bodies: unknown[] = [];
    const created = 1_788_548_737_221;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "POST" && request.url.endsWith("/api/session")) {
        bodies.push(await request.json());
        return jsonResponse({ data: { id: "ses_new", title, created } });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.create({ title });
      expect(bodies).toEqual([{
        location: { directory: "/workspace" },
        ...(title === undefined ? {} : { title }),
      }]);
      expect(result.data?.title).toBe(title || `New session - ${new Date(created).toISOString()}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retains native assistant errors even when a failed turn has text and a completion time", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET" && new URL(request.url).pathname.endsWith("/api/session/ses_failed/message")) {
        return jsonResponse({ data: [{
          id: "msg_failed",
          type: "assistant",
          time: { created: 10, completed: 20 },
          content: [{ type: "text", text: "Partial response" }],
          error: { type: "unknown", message: "provider unavailable" },
        }] });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.messages({ sessionID: "ses_failed" });
      expect(result.data).toEqual([{
        info: {
          id: "msg_failed",
          sessionID: "ses_failed",
          role: "assistant",
          time: { created: 10, completed: 20 },
          error: { name: "UnknownError", data: { message: "provider unavailable" } },
        },
        parts: [{
          id: "msg_failed:0",
          messageID: "msg_failed",
          sessionID: "ses_failed",
          type: "text",
          text: "Partial response",
        }],
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps active v2 sessions to busy compatibility statuses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET" && request.url.endsWith("/api/session/active")) {
        return jsonResponse({ data: { ses_active: { type: "running" } } });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.status();

      expect(result.data).toEqual({ ses_active: { type: "busy" } });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps captured v2 message content and presents shell tool parts as bash", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET" && new URL(request.url).pathname.endsWith("/api/session/ses_tool/message")) {
        return jsonResponse({ data: [capturedV2ToolMessage] });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.messages({ sessionID: "ses_tool" });

      expect(result.data).toEqual([{
        info: {
          id: "msg_06e0e76b900178zSuF55n4XEPY",
          sessionID: "ses_tool",
          role: "assistant",
          time: { created: 1_788_552_837_299, completed: 1_788_552_838_186 },
        },
        parts: [
          {
            id: "msg_06e0e76b900178zSuF55n4XEPY:0",
            messageID: "msg_06e0e76b900178zSuF55n4XEPY",
            sessionID: "ses_tool",
            type: "text",
            text: "Running the shell.\n",
          },
          {
            id: "call_captured_shell",
            messageID: "msg_06e0e76b900178zSuF55n4XEPY",
            sessionID: "ses_tool",
            type: "tool",
            callID: "call_captured_shell",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "printf 'TOOL_RESULT_OK\\n'", timeout: 30_000 },
              output: "TOOL_RESULT_OK\n\nCommand exited with code 0.",
              title: "bash",
              metadata: { status: "completed", truncated: false, exit: 0 },
              time: { start: 1_788_552_838_052, end: 1_788_552_838_184 },
            },
          },
        ],
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("waits for native prompt admission and returns its actual response without waiting for execution", async () => {
    const originalFetch = globalThis.fetch;
    const admission = Promise.withResolvers<Response>();
    const dispatched = Promise.withResolvers<Request>();
    const response = new Response(null, { status: 204, headers: { "X-Admission": "accepted" } });
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith("/model")) return jsonResponse({ data: {} });
      if (request.url.endsWith("/prompt")) {
        dispatched.resolve(request);
        return admission.promise;
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      let settled = false;
      const pending = client.session.promptAsync({
        sessionID: "ses_prompt",
        model: { providerID: "witness", modelID: "model" },
        parts: [{ type: "text", text: "hello" }],
      }).finally(() => { settled = true; });
      const request = await dispatched.promise;
      await delay(10);
      expect(settled).toBe(false);
      expect(await request.clone().json()).toEqual({ text: "hello" });
      admission.resolve(response);
      const result = await pending;
      expect(result.error).toBeUndefined();
      expect(result.response).toBe(response);
      expect(result.response.status).toBe(204);
      expect(result.request.url).toBe(request.url);
    } finally {
      admission.resolve(response);
      globalThis.fetch = originalFetch;
    }
  });

  test("workspace streams reject foreign and unscoped permission events", async () => {
    const originalFetch = globalThis.fetch;
    const events = [
      { ...capturedPermissionAsked, location: undefined, data: { ...capturedPermissionAsked.data, sessionID: "ses_unscoped" } },
      { ...capturedPermissionAsked, location: { directory: "/other" }, data: { ...capturedPermissionAsked.data, sessionID: "ses_foreign" } },
      capturedPermissionAsked,
    ];
    globalThis.fetch = async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace/", {});
      const subscription = await client.event.subscribe();
      const next = await subscription.stream.next();
      expect(next.value).toMatchObject({ type: "permission.asked", properties: { sessionID: "ses_child" } });
      await subscription.stream.return(undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("discovers external forks from authoritative sessions once, without fetching foreign events or the source", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    const info = {
      id: "ses_fork", title: "Source (fork #1)", slug: "fork-slug", projectID: "project",
      location: { directory: "/workspace/" }, version: "native",
      time: { created: 100, updated: 200 },
      fork: { sessionID: "ses_source", boundary: nativeForkEvent.data.boundary },
    };
    const events = [
      { ...nativeForkEvent, location: undefined, data: { ...nativeForkEvent.data, sessionID: "ses_unscoped" } },
      { ...nativeForkEvent, location: { directory: "/other" }, data: { ...nativeForkEvent.data, sessionID: "ses_foreign" } },
      nativeForkEvent, nativeForkEvent, capturedPermissionAsked,
    ];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return request.url.endsWith("/api/event")
        ? new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
        : jsonResponse({ data: info });
    };
    try {
      const client = createClientV2("http://opencode.test/workspace/owned/opencode2", "/workspace", { token: "fixture-token" });
      const subscription = await client.event.subscribe();
      const received = [];
      for await (const event of subscription.stream) received.push(event);
      expect(received).toHaveLength(2);
      expect(received.find((event) => event.type === "session.created")).toEqual({ type: "session.created", properties: { info: {
        id: info.id, title: info.title, slug: info.slug, projectID: info.projectID,
        directory: info.location.directory, version: info.version, time: info.time,
      } } });
      expect(received[0]?.type).toBe("permission.asked");
      expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
        ["GET", "/workspace/owned/opencode2/api/event"], ["GET", "/workspace/owned/opencode2/api/session/ses_fork"],
      ]);
      expect(requests.every((request) => request.headers.get("Authorization") === "Bearer fixture-token")).toBe(true);
      const fork = await client.session.fork({ sessionID: "ses_source", messageID: "msg_source" });
      expect(fork.data?.id).toBe("ses_fork");
      expect(fork.data?.parentID).toBeUndefined();
      expect([requests[2]?.method, new URL(requests[2]?.url ?? "").pathname]).toEqual(["POST", "/workspace/owned/opencode2/api/session/ses_source/fork"]);
      expect(await requests[2]?.json()).toEqual({ before: "msg_source" });
    } finally { globalThis.fetch = originalFetch; }
  });

  test("held fork discovery does not block permission or text, wakes a waiting reader, and deduplicates replays", async () => {
    const originalFetch = globalThis.fetch;
    const source = eventStream();
    const controller = new AbortController();
    const lookup = Promise.withResolvers<Response>();
    const requests: Request[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith("/api/event")) return source.response;
      requests.push(request);
      return lookup.promise;
    };
    try {
      const subscription = await createClientV2("http://opencode.test/opencode2", "/workspace", {}).event.subscribe({}, { signal: controller.signal });
      source.send(nativeForkEvent);
      source.send(nativeForkEvent);
      source.send(capturedPermissionAsked);
      const started = Date.now();
      expect((await subscription.stream.next()).value?.type).toBe("permission.asked");
      const data = { sessionID: "ses_other", assistantMessageID: "msg_other", ordinal: 0 };
      source.send({ type: "session.text.started", location: { directory: "/workspace" }, data });
      expect((await subscription.stream.next()).value?.type).toBe("message.updated");
      expect((await subscription.stream.next()).value?.type).toBe("message.part.updated");
      for (let index = 0; index < 100; index += 1) {
        source.send({ type: "session.text.delta", location: { directory: "/workspace" }, data: { ...data, delta: "text" } });
        expect((await subscription.stream.next()).value).toMatchObject({
          type: "message.part.delta", properties: { sessionID: "ses_other", delta: "text" },
        });
      }
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.signal.aborted).toBe(false);

      const pending = subscription.stream.next();
      await delay(0);
      lookup.resolve(jsonResponse({ data: { id: "ses_fork", title: "Late fork", location: { directory: "/workspace" } } }));
      expect((await pending).value).toMatchObject({
        type: "session.created", properties: { info: { id: "ses_fork", title: "Late fork" } },
      });
      // Discovery must not discard the outstanding SSE read or refetch success.
      source.send(nativeForkEvent);
      source.send(capturedPermissionReplied);
      expect((await subscription.stream.next()).value?.type).toBe("permission.replied");
      expect(requests).toHaveLength(1);
      await subscription.stream.return(undefined);
      expect(source.cancelled).toBe(true);
      expect(source.body.locked).toBe(false);
    } finally {
      controller.abort();
      globalThis.fetch = originalFetch;
    }
  });

  test.each(["pending", "queued"])("deletion discards %s fork discovery without affecting another lookup", async (phase) => {
    const originalFetch = globalThis.fetch;
    const source = eventStream();
    const controller = new AbortController();
    const lookup = Promise.withResolvers<Response>();
    const otherLookup = Promise.withResolvers<Response>();
    const requests: Request[] = [];
    const info = { id: "ses_fork", title: "Deleted fork", location: { directory: "/workspace" } };
    const deleted = {
      type: "session.deleted", location: { directory: "/workspace" },
      data: phase === "pending" ? { sessionID: "ses_fork" } : { info: { id: "ses_fork" } },
    };
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith("/api/event")) return source.response;
      requests.push(request);
      if (request.url.endsWith("/api/session/ses_fork")) return lookup.promise;
      if (request.url.endsWith("/api/session/ses_other")) return otherLookup.promise;
      throw new Error(`Unexpected request: ${request.url}`);
    };
    try {
      const subscription = await createClientV2("http://opencode.test/opencode2", "/workspace", {}).event.subscribe({}, { signal: controller.signal });
      // One SSE chunk lets lookup completion queue while parsing is paused at
      // the permission yield, before the matching deletion is translated.
      source.send(
        nativeForkEvent,
        { ...nativeForkEvent, data: { ...nativeForkEvent.data, sessionID: "ses_other" } },
        { ...deleted, location: { directory: "/other" } },
        { ...deleted, location: undefined },
        capturedPermissionAsked, deleted, capturedPermissionReplied,
      );
      expect((await subscription.stream.next()).value?.type).toBe("permission.asked");
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => !request.signal.aborted)).toBe(true);
      if (phase === "queued") {
        lookup.resolve(jsonResponse({ data: info }));
        await delay(0);
      }
      expect((await subscription.stream.next()).value).toMatchObject({
        type: "session.deleted", properties: { sessionID: "ses_fork" },
      });
      if (phase === "pending") expect(requests[0]?.signal.aborted).toBe(true);
      expect(requests[1]?.signal.aborted).toBe(false);
      expect((await subscription.stream.next()).value?.type).toBe("permission.replied");
      // The deleted lookup's transport ignores cancellation and returns stale
      // metadata; only the unrelated fork may still be discovered.
      lookup.resolve(jsonResponse({ data: info }));
      otherLookup.resolve(jsonResponse({ data: { ...info, id: "ses_other", title: "Kept fork" } }));
      expect((await subscription.stream.next()).value).toMatchObject({
        type: "session.created", properties: { info: { id: "ses_other", title: "Kept fork" } },
      });
      source.send(nativeForkEvent, capturedPermissionAsked);
      expect((await subscription.stream.next()).value?.type).toBe("permission.asked");
      expect(requests).toHaveLength(2);
      source.close();
      expect(await subscription.stream.next()).toEqual({ done: true, value: undefined });
      expect(source.body.locked).toBe(false);
    } finally { controller.abort(); globalThis.fetch = originalFetch; }
  });

  test.each(["deleted", "unavailable", "network", "missing", "wrong-id", "foreign", "unscoped", "timeout"])(
    "skips a %s fork lookup, continues the stream, and allows recovery on replay", async (failure) => {
      const originalFetch = globalThis.fetch;
      const source = eventStream();
      const controller = new AbortController();
      let lookups = 0;
      let lookupSignal: AbortSignal | undefined;
      const info = { id: "ses_fork", title: "Recovered fork", location: { directory: "/workspace" }, time: { created: 100, updated: 200 } };
      globalThis.fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.url.endsWith("/api/event")) return source.response;
        lookups += 1;
        if (lookups > 1) return jsonResponse({ data: info });
        lookupSignal = request.signal;
        if (failure === "deleted") return jsonResponse({}, 404);
        if (failure === "unavailable") return jsonResponse({}, 503);
        if (failure === "network") throw new TypeError("Network unavailable");
        if (failure === "missing") return jsonResponse({ data: null });
        if (failure === "wrong-id") return jsonResponse({ data: { ...info, id: "ses_source" } });
        if (failure === "foreign") return jsonResponse({ data: { ...info, location: { directory: "/other" } } });
        if (failure === "unscoped") return jsonResponse({ data: { ...info, location: undefined } });
        // An IPC transport may ignore cancellation entirely.
        return new Promise<Response>(() => {});
      };
      try {
        const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
        const subscription = await client.event.subscribe({}, { signal: controller.signal });
        source.send(nativeForkEvent);
        source.send(capturedPermissionAsked);
        const started = Date.now();
        expect((await subscription.stream.next()).value?.type).toBe("permission.asked");
        expect(Date.now() - started).toBeLessThan(1_000);
        if (failure === "timeout") {
          expect(lookupSignal?.aborted).toBe(false);
          await new Promise<void>((resolve) => lookupSignal?.addEventListener("abort", () => resolve(), { once: true }));
          expect(Date.now() - started).toBeLessThan(3_000);
        }
        // Replay after failure has settled, not while the first lookup is live.
        await delay(0);
        source.send(nativeForkEvent);
        expect((await subscription.stream.next()).value).toMatchObject({
          type: "session.created", properties: { info: { id: info.id, title: info.title } },
        });
        source.close();
        expect(await subscription.stream.next()).toEqual({ done: true, value: undefined });
        expect(source.body.locked).toBe(false);
        expect(lookups).toBe(2);
      } finally { controller.abort(); globalThis.fetch = originalFetch; }
    },
  );

  test.each(["abort", "return", "read error"])("%s cleans up a waiting subscription and its fork lookup without emitting a session", async (action) => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const source = eventStream();
    const dispatched = Promise.withResolvers<Request>();
    const lookup = Promise.withResolvers<Response>();
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith("/api/event")) return source.response;
      dispatched.resolve(request);
      return lookup.promise;
    };
    try {
      const subscription = await createClientV2("http://opencode.test/opencode2", "/workspace", {}).event.subscribe({}, { signal: controller.signal });
      source.send(nativeForkEvent);
      const pending = subscription.stream.next();
      const request = await dispatched.promise;
      await delay(0);
      if (action === "read error") {
        const error = new Error("SSE read failed");
        source.fail(error);
        await expect(pending).rejects.toBe(error);
      } else {
        if (action === "abort") controller.abort();
        else expect(await subscription.stream.return(undefined)).toEqual({ done: true, value: undefined });
        expect(await pending).toEqual({ done: true, value: undefined });
      }
      expect(request.signal.aborted).toBe(true);
      expect(source.cancelled).toBe(action !== "read error");
      expect(source.body.locked).toBe(false);
      lookup.resolve(jsonResponse({ data: { id: "ses_fork", location: { directory: "/workspace" } } }));
      expect(await subscription.stream.next()).toEqual({ done: true, value: undefined });
    } finally { controller.abort(); globalThis.fetch = originalFetch; }
  });

  test.each([400, 409, 500])("returns native prompt admission failure %i to a separate send client", async (status) => {
    const originalFetch = globalThis.fetch;
    const error = { name: "SessionPromptFailed", error: { message: "admission rejected", detail: { retryable: false } } };
    const response = jsonResponse(error, status);
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith("/api/event")) {
        return new Response("", { headers: { "Content-Type": "text/event-stream" } });
      }
      if (request.url.endsWith("/model")) return jsonResponse({ data: {} });
      if (request.url.endsWith("/prompt")) {
        return response;
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const eventClient = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const subscription = await eventClient.event.subscribe();
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.promptAsync({
        sessionID: "ses_failure",
        model: { providerID: "witness", modelID: "model" },
        parts: [{ type: "text", text: "hello" }],
      });
      expect(result.response).toBe(response);
      expect(result.error).toEqual(error);
      expect(result.data).toBeUndefined();
      expect(result.request.url).toEndWith("/api/session/ses_failure/prompt");
      expect(await subscription.stream.next()).toEqual({ done: true, value: undefined });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends attachments as the engine's files", async () => {
    const originalFetch = globalThis.fetch;
    let sent: unknown = null;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith("/prompt")) sent = await request.json();
      return jsonResponse({ data: {} });
    };
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      await client.session.promptAsync({
        sessionID: "ses_files",
        model: { providerID: "omnirush", modelID: "gpt-6-astra" },
        parts: [{ type: "text", text: "look" }, { type: "file", mime: "image/png", url: "data:image/png;base64,AA==", filename: "a.png" } as never],
      });
      expect(sent).toEqual({ text: "look", files: [{ uri: "data:image/png;base64,AA==", name: "a.png" }] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each(["model", "prompt"])("propagates network rejection from %s without fabricating success", async (endpoint) => {
    const originalFetch = globalThis.fetch;
    const failure = new TypeError("network unavailable");
    const paths: string[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      paths.push(new URL(request.url).pathname);
      if (request.url.endsWith(`/${endpoint}`)) throw failure;
      return jsonResponse({ data: {} });
    };
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      await expect(client.session.promptAsync({
        sessionID: "ses_failure",
        model: { providerID: "witness", modelID: "model" },
        parts: [{ type: "text", text: "hello" }],
      })).rejects.toBe(failure);
      expect(paths).toHaveLength(endpoint === "model" ? 1 : 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves model admission failure and does not dispatch a prompt", async () => {
    const originalFetch = globalThis.fetch;
    const error = { name: "ModelNotFound", data: { modelID: "missing" } };
    const response = jsonResponse(error, 404);
    const paths: string[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      paths.push(new URL(request.url).pathname);
      return response;
    };
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.promptAsync({
        sessionID: "ses_failure",
        model: { providerID: "witness", modelID: "missing" },
        parts: [{ type: "text", text: "hello" }],
      });
      expect(result.response).toBe(response);
      expect(result.error).toEqual(error);
      expect(result.data).toBeUndefined();
      expect(paths).toEqual(["/opencode2/api/session/ses_failure/model"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each(["model", "prompt"])("propagates abort while waiting for %s admission", async (endpoint) => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const dispatched = Promise.withResolvers<Request>();
    const paths: string[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      paths.push(new URL(request.url).pathname);
      if (!request.url.endsWith(`/${endpoint}`)) return jsonResponse({ data: {} });
      dispatched.resolve(request);
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    };
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const pending = client.session.promptAsync({
        sessionID: "ses_abort",
        model: { providerID: "witness", modelID: "model" },
        parts: [{ type: "text", text: "hello" }],
      }, { signal: controller.signal });
      const request = await dispatched.promise;
      const failure = new DOMException("Cancelled admission", "AbortError");
      controller.abort(failure);
      await expect(pending).rejects.toBe(failure);
      expect(request.signal.aborted).toBe(true);
      expect(paths).toHaveLength(endpoint === "model" ? 1 : 2);
    } finally {
      controller.abort();
      globalThis.fetch = originalFetch;
    }
  });

  test("lists and replies to captured v2 permission requests", async () => {
    const originalFetch = globalThis.fetch;
    const replyBodies: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET" && request.url.endsWith("/api/session")) {
        return jsonResponse({ data: [{ id: "ses_child" }] });
      }
      if (request.method === "GET" && request.url.endsWith("/api/session/ses_child/permission")) {
        return jsonResponse({ data: [capturedPermissionAsked.data] });
      }
      if (request.method === "POST" && request.url.endsWith("/api/session/ses_child/permission/per_child/reply")) {
        replyBodies.push(await request.json());
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const v2 = await client.v2.session.permission.list({ sessionID: "ses_child" });
      expect(v2.data).toEqual({
        data: [{
          id: "per_child",
          sessionID: "ses_child",
          action: "shell",
          resources: ["printf 'TOOL_RESULT_OK'"],
          save: ["printf *"],
          metadata: { message: "Allow this command?" },
          source: { type: "tool", messageID: "msg_child", callID: "call_child" },
        }],
      });

      const legacy = await client.permission.list();
      expect(legacy.data).toEqual([{
        id: "per_child",
        sessionID: "ses_child",
        permission: "shell",
        patterns: ["printf 'TOOL_RESULT_OK'"],
        metadata: { action: "shell", message: "Allow this command?" },
        always: ["printf *"],
        tool: { messageID: "msg_child", callID: "call_child" },
      }]);

      const legacyReply = await client.permission.reply({ requestID: "per_child", reply: "always" });
      expect(legacyReply.data).toBe(true);

      await client.v2.session.permission.list({ sessionID: "ses_child" });
      const reply = await client.v2.session.permission.reply({
        sessionID: "ses_child",
        requestID: "per_child",
        reply: "once",
      });
      expect(reply.error).toBeUndefined();
      expect(reply.response.status).toBe(204);
      expect(replyBodies).toEqual([{ decision: "always" }, { decision: "once" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


test("v2 provider catalog retains display names without exposing request settings", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.endsWith("/api/model")) return jsonResponse({ data: [{ id: "coding", providerID: "lpr_fixture", name: "Coding" }] });
    if (request.url.endsWith("/api/provider")) return jsonResponse({ data: [{ id: "lpr_fixture", name: "Assigned Coding", settings: { apiKey: "fixture-private" } }] });
    if (request.url.endsWith("/api/model/default")) return jsonResponse({ data: {} });
    throw new Error(`Unexpected request: ${request.url}`);
  };
  try {
    const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
    const result = await client.provider.list();
    expect(result.data?.all[0]?.name).toBe("Assigned Coding");
    expect(JSON.stringify(result.data)).not.toContain("fixture-private");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

describe("v2 question forms", () => {
  const form = {
    id: "frm_choice", sessionID: "ses_side", title: "Questions",
    metadata: { kind: "question", tool: { messageID: "msg_side", id: "call_question" } },
    fields: [
      { key: "q0", type: "string", title: "Format", description: "Which format?", custom: true,
        options: [{ label: "Summary", value: "summary_value", description: "A short overview" }] },
      { key: "q1", type: "multiselect", title: "Sections", description: "Which sections?", custom: true,
        options: [{ label: "Facts", value: "facts_value" }, { label: "Actions", value: "actions_value" }] },
    ],
  };

  test("maps pending, answered, and cancelled forms to the existing question UI protocol", () => {
    const state = createV2EventTranslationState();
    expect(translateV2Event({ type: "form.created", data: { form } }, state)).toEqual([{
      type: "question.asked", properties: {
        id: "frm_choice", sessionID: "ses_side", tool: { messageID: "msg_side", callID: "call_question" },
        questions: [
          { header: "Format", question: "Which format?", custom: true, multiple: false,
            options: [{ label: "Summary", description: "A short overview" }] },
          { header: "Sections", question: "Which sections?", custom: true, multiple: true,
            options: [{ label: "Facts", description: "" }, { label: "Actions", description: "" }] },
        ],
      },
    }]);
    expect(translateV2Event({ type: "form.created", data: { form: { ...form, metadata: { kind: "oauth" } } } }, state)).toBeNull();
    for (const [event, expected] of [["form.replied", "question.replied"], ["form.cancelled", "question.rejected"]]) {
      expect(translateV2Event({ type: event, data: { id: form.id, sessionID: form.sessionID } }, state)).toEqual([
        { type: expected, properties: { requestID: form.id, sessionID: form.sessionID } },
      ]);
    }
  });

  test("an interaction client can answer a live form it never listed, preserving values and custom text", async () => {
    const originalFetch = globalThis.fetch;
    const writes: { method: string; path: string; body: unknown }[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path.endsWith("/api/form")) return Response.json({ data: [form] });
      writes.push({ method: request.method, path, body: request.body ? await request.json() : null });
      return new Response(null, { status: 204 });
    };
    try {
      const client = createClientV2("http://owner.test/opencode2", "/workspace", {});
      expect((await client.question.reply({ requestID: form.id, answers: [["Summary"], ["Facts", "Custom section"]] })).data).toBe(true);
      expect(writes).toEqual([{ method: "POST", path: "/opencode2/api/session/ses_side/form/frm_choice/reply", body: {
        answer: { q0: "summary_value", q1: ["facts_value", "Custom section"] },
      } }]);
      expect((await client.question.reject({ requestID: form.id })).data).toBe(true);
      expect(writes.at(-1)).toEqual({ method: "DELETE", path: "/opencode2/api/session/ses_side/form/frm_choice", body: null });
    } finally { globalThis.fetch = originalFetch; }
  });

  test("failed list and reply requests remain failures and do not settle another question", async () => {
    const originalFetch = globalThis.fetch;
    const methods: string[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      methods.push(request.method);
      return Response.json({ message: "Unavailable" }, { status: 503 });
    };
    try {
      const client = createClientV2("http://owner.test/opencode2", "/workspace", {});
      expect((await client.question.reply({ requestID: form.id, answers: [["Summary"]] })).response.status).toBe(503);
      expect(methods).toEqual(["GET"]);
      globalThis.fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return request.method === "GET" ? Response.json({ data: [form] }) : Response.json({ message: "Try again" }, { status: 503 });
      };
      expect((await client.question.reply({ requestID: form.id, answers: [["Summary"]] })).response.status).toBe(503);
      expect((await client.question.list()).data?.map((item) => item.id)).toEqual([form.id]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("writes session context before prompting and fails closed if it cannot be written", async () => {
    const originalFetch = globalThis.fetch;
    const requests: { method: string; path: string; body: unknown }[] = [];
    let status = 204;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      requests.push({ method: request.method, path, body: await request.json() });
      return path.includes("/instructions/") && status !== 204
        ? Response.json({ message: "Unavailable" }, { status }) : new Response(null, { status: 204 });
    };
    try {
      const client = createClientV2("http://owner.test/opencode2", "/workspace", {});
      const parameters = { sessionID: "ses_side", model: { providerID: "mock", modelID: "model" },
        system: "Main conversation reference: ses_main", parts: [{ type: "text", text: "What is happening?" }] };
      expect((await client.session.promptAsync(parameters)).response.status).toBe(204);
      expect(requests.map((item) => item.method)).toEqual(["POST", "PUT", "POST"]);
      expect(requests[1]).toMatchObject({ path: "/opencode2/api/experimental/session/ses_side/instructions/entries/omnirush-context", body: { value: parameters.system } });
      expect(requests[2]?.body).toEqual({ text: "What is happening?" });
      requests.length = 0;
      await client.session.promptAsync({ ...parameters, messageID: "msg_0123456789abUIdraft00000" });
      expect(requests[2]?.body).toEqual({ text: "What is happening?", id: "msg_0123456789abUIdraft00000" });
      requests.length = 0; status = 503;
      expect((await client.session.promptAsync(parameters)).response.status).toBe(503);
      expect(requests.map((item) => item.method)).toEqual(["POST", "PUT"]);
    } finally { globalThis.fetch = originalFetch; }
  });
});

describe("OpenCode 2.0.32 routes", () => {
  // Shapes captured from a stock 2.0.32 `opencode serve`.
  const session = {
    id: "ses_main", projectID: "project", title: "Main", cost: 0, location: { directory: "/workspace" },
    time: { created: 1, updated: 2 }, revert: { messageID: "msg_user", snapshot: "abc", files: [] },
  };

  async function withRoutes(
    handle: (request: Request, path: string) => Response | Promise<Response>,
    run: (client: ReturnType<typeof createClientV2>, calls: { method: string; path: string; body: unknown }[]) => Promise<void>,
  ) {
    const originalFetch = globalThis.fetch;
    const calls: { method: string; path: string; body: unknown }[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname.replace("/opencode2", "") + url.search;
      calls.push({ method: request.method, path, body: request.body ? await request.clone().json() : null });
      return handle(request, path);
    };
    try { await run(createClientV2("http://owner.test/opencode2", "/workspace", {}), calls); } finally { globalThis.fetch = originalFetch; }
  }

  test("health reads /api/info and rename patches the session then rereads it", async () => {
    await withRoutes((request, path) => path === "/api/info"
      ? Response.json({ version: "2.0.32", pid: 1, urls: [], paths: { tmp: "/tmp" } })
      : request.method === "PATCH" ? new Response(null, { status: 204 }) : Response.json({ data: { ...session, title: "Renamed" } }),
    async (client, calls) => {
      expect((await client.global.health()).data).toEqual({ healthy: true, version: "2.0.32" });
      const renamed = await client.session.update({ sessionID: "ses_main", title: "Renamed" });
      expect(renamed.data?.title).toBe("Renamed");
      expect(renamed.data?.revert).toEqual({ messageID: "msg_user", snapshot: "abc" });
      expect(calls.slice(1)).toEqual([
        { method: "PATCH", path: "/api/session/ses_main", body: { title: "Renamed" } },
        { method: "GET", path: "/api/session/ses_main", body: null },
      ]);
    });
  });

  test("revert stages without committing, unrevert clears, and compact, shell and command use native routes", async () => {
    await withRoutes((request, path) => {
      if (path.endsWith("/revert/stage")) return Response.json({ data: session.revert });
      if (path.endsWith("/compact")) return Response.json({ data: { id: "msg_compact", type: "compaction" } });
      if (request.method === "GET") return Response.json({ data: session });
      return new Response(null, { status: 204 });
    }, async (client, calls) => {
      expect((await client.session.revert({ sessionID: "ses_main", messageID: "msg_user", partID: "p" })).data?.revert?.messageID).toBe("msg_user");
      expect((await client.session.unrevert({ sessionID: "ses_main" })).data?.id).toBe("ses_main");
      expect((await client.session.summarize({ sessionID: "ses_main", providerID: "mock", modelID: "m1" })).data).toBe(true);
      expect((await client.session.shell({ sessionID: "ses_main", command: "echo hi", agent: "build" })).error).toBeUndefined();
      expect((await client.session.command({ sessionID: "ses_main", command: "init", arguments: "focus", model: "mock/m1" })).error).toBeUndefined();
      expect(calls).toEqual([
        { method: "POST", path: "/api/session/ses_main/revert/stage", body: { messageID: "msg_user" } },
        { method: "GET", path: "/api/session/ses_main", body: null },
        { method: "DELETE", path: "/api/session/ses_main/revert", body: null },
        { method: "GET", path: "/api/session/ses_main", body: null },
        { method: "POST", path: "/api/session/ses_main/compact", body: {} },
        { method: "POST", path: "/api/session/ses_main/shell", body: { command: "echo hi" } },
        { method: "POST", path: "/api/session/ses_main/model", body: { model: { providerID: "mock", id: "m1" } } },
        { method: "POST", path: "/api/session/ses_main/command", body: { name: "init", text: "focus" } },
      ]);
    });
  });

  test("a failed native op stays a failure", async () => {
    await withRoutes(() => Response.json({ message: "busy" }, { status: 409 }), async (client, calls) => {
      expect((await client.session.revert({ sessionID: "ses_main", messageID: "msg_user" })).response.status).toBe(409);
      expect((await client.session.command({ sessionID: "ses_main", command: "init", model: "mock/m1" })).response.status).toBe(409);
      expect(calls.map((call) => call.path)).toEqual(["/api/session/ses_main/revert/stage", "/api/session/ses_main/model"]);
    });
  });

  test("history pages newest first through cursors and returns the latest messages oldest first", async () => {
    const message = (n: number) => ({ id: `msg_${n}`, type: "user", text: `m${n}`, time: { created: n } });
    await withRoutes((_request, path) => {
      const cursor = new URL(`http://x${path}`).searchParams.get("cursor");
      const start = cursor ? Number(cursor) : 250;
      const limit = Number(new URL(`http://x${path}`).searchParams.get("limit"));
      const data = Array.from({ length: Math.min(limit, start) }, (_, index) => start - index === 249
        ? { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 249 } } : message(start - index));
      return Response.json({ data, cursor: { next: String(start - data.length) } });
    }, async (client, calls) => {
      const all = await client.session.messages({ sessionID: "ses_main" });
      expect(all.data?.map((item) => item.info.id).slice(0, 2)).toEqual(["msg_1", "msg_2"]);
      expect(all.data).toHaveLength(249);
      expect(calls.map((call) => call.path)).toEqual([
        "/api/session/ses_main/message?limit=200&order=desc",
        "/api/session/ses_main/message?limit=200&cursor=50",
      ]);
      calls.length = 0;
      const latest = await client.session.messages({ sessionID: "ses_main", limit: 3 });
      expect(latest.data?.map((item) => item.info.id)).toEqual(["msg_247", "msg_248", "msg_250"]);
      expect(calls.map((call) => call.path)).toEqual([
        "/api/session/ses_main/message?limit=3&order=desc",
        "/api/session/ses_main/message?limit=1&cursor=247",
      ]);
    });
  });

  test("a user shell message renders as one bash card and its synthetic notice stays hidden", async () => {
    await withRoutes(() => Response.json({ data: [
      { id: "msg_notice", type: "synthetic", text: "<shell id=\"sh_1\" state=\"completed\" command=\"echo hi\">\nhi\n</shell>",
        metadata: { source: "shell", shellID: "sh_1" }, time: { created: 3 } },
      { id: "msg_shell", type: "shell", shellID: "sh_1", command: "echo hi", status: "exited", exit: 0,
        output: { output: "hi\n", cursor: 3, size: 3, truncated: false }, time: { created: 2, completed: 3 } },
    ] }), async (client) => {
      const result = await client.session.messages({ sessionID: "ses_main" });
      expect(result.data).toHaveLength(1);
      expect(result.data?.[0]?.info.role).toBe("assistant");
      expect(result.data?.[0]?.parts).toMatchObject([{ type: "tool", tool: "bash", callID: "sh_1",
        state: { status: "completed", input: { command: "echo hi" }, output: "hi\n" } }]);
    });
  });

  test("revert events move the session cursor", () => {
    const state = createV2EventTranslationState();
    expect(translateV2Event({ type: "session.revert.staged", data: { sessionID: "ses_main", revert: session.revert } }, state))
      .toEqual([{ type: "session.updated", properties: { info: { id: "ses_main", revert: { messageID: "msg_user" } } } }]);
    for (const type of ["session.revert.cleared", "session.revert.committed"]) {
      expect(translateV2Event({ type, data: { sessionID: "ses_main", to: "msg_user" } }, state))
        .toEqual([{ type: "session.updated", properties: { info: { id: "ses_main" } } }]);
    }
    expect(translateV2Event({ type: "permission.replied", data: { sessionID: "ses_main", requestID: "per_1", decision: "always" } }, state))
      .toEqual([{ type: "permission.replied", properties: { sessionID: "ses_main", requestID: "per_1", reply: "always" } }]);
  });

  test.each([
    ["read", { path: "a.py" }, "read", { filePath: "a.py", path: "a.py" }],
    ["write", { path: "b.txt", content: "x" }, "write", { filePath: "b.txt", path: "b.txt", content: "x" }],
    ["edit", { path: "a.py", oldString: "1", newString: "2" }, "edit", { filePath: "a.py", path: "a.py" }],
    ["skill", { id: "pdf" }, "skill", { name: "pdf", id: "pdf" }],
    ["patch", { patchText: "*** Begin Patch" }, "apply_patch", { patchText: "*** Begin Patch" }],
    ["websearch", { query: "news" }, "websearch", { query: "news" }],
  ])("native %s calls render with the card's field names", (name, input, tool, expected) => {
    const state = createV2EventTranslationState();
    const identity = { sessionID: "ses_main", assistantMessageID: "msg_a", id: "call_1" };
    translateV2Event({ type: "session.tool.input.started", data: { ...identity, name } }, state);
    expect(translateV2Event({ type: "session.tool.called", created: 1, data: { ...identity, input } }, state))
      .toMatchObject([{ properties: { part: { tool, state: { status: "running", input: expected } } } }]);
    expect(input).not.toHaveProperty("filePath");
  });
});

test("MCP status from the 2.x engine reads as the 1.x status map", async () => {
  const { v2McpStatusMap } = await import("../src/app/lib/opencode-v2-adapter");
  expect(v2McpStatusMap({ data: [{ name: "memory", status: { status: "connected" } }, { name: "gh", status: { status: "failed", error: "boom" } }, { name: 3 }] }))
    .toEqual({ memory: { status: "connected" }, gh: { status: "failed", error: "boom" } });
  expect(v2McpStatusMap(null)).toEqual({});
});

describe("OpenCode 2.0.32 workspace reads", () => {
  test("agents, commands, files, vcs, projects and diffs read native routes in the 1.x shapes", async () => {
    const originalFetch = globalThis.fetch;
    const paths: string[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname.replace("/opencode2", "") + url.search;
      paths.push(`${request.method} ${path}`);
      if (url.pathname.endsWith("/api/agent")) return Response.json({ data: [
        { id: "build", name: "Build", mode: "primary", hidden: false, permissions: [], request: {}, description: "Default", model: { id: "m1", providerID: "mock" } },
        { id: "compaction", name: "Compaction", mode: "primary", hidden: true, permissions: [], request: {} },
      ] });
      if (url.pathname.endsWith("/api/command")) return Response.json({ data: [{ name: "init" }] });
      if (url.pathname.endsWith("/api/fs/find")) return Response.json({ data: [{ path: "/", type: "directory" }, { path: "src/", type: "directory" }, { path: "src/a.ts", type: "file" }] });
      if (url.pathname.endsWith("/api/vcs")) return Response.json({ data: { provider: "git", branch: { current: "feat", default: "main" } } });
      if (url.pathname.endsWith("/api/vcs/diff")) return Response.json({ data: [{ file: "a.ts", patch: "p", additions: 1, deletions: 0, status: "modified" }] });
      if (url.pathname.endsWith("/api/project")) return Response.json([{ id: "prj", canonical: "/workspace", time: { created: 1, updated: 1, active: 1 }, sandboxes: [] }]);
      if (url.pathname.endsWith("/api/location")) return Response.json({ directory: "/workspace/sub", project: { id: "prj", directory: "/workspace", canonical: "/workspace" } });
      if (url.pathname.endsWith("/diff")) return Response.json({ data: [{ file: "b.ts", patch: "q", additions: 0, deletions: 1, status: "deleted" }] });
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    };
    try {
      const client = createClientV2("http://owner.test/opencode2", "/workspace", {});
      expect((await client.app.agents()).data).toEqual([
        { name: "build", mode: "primary", hidden: false, permission: [], options: {}, description: "Default", model: { providerID: "mock", modelID: "m1" } },
        { name: "compaction", mode: "primary", hidden: true, permission: [], options: {} },
      ]);
      expect((await client.command.list()).data).toEqual([{ name: "init", template: "", hints: [] }]);
      expect((await client.find.files({ query: "a", dirs: "true", limit: 50 })).data).toEqual(["src/", "src/a.ts"]);
      expect((await client.vcs.get()).data).toEqual({ branch: "feat", default_branch: "main" });
      expect((await client.vcs.diff({ mode: "git" })).data).toMatchObject([{ file: "a.ts", status: "modified" }]);
      expect((await client.project.list()).data).toMatchObject([{ id: "prj", worktree: "/workspace" }]);
      expect((await client.project.current()).data).toMatchObject({ id: "prj", worktree: "/workspace" });
      expect((await client.path.get()).data).toEqual({ home: "", state: "", config: "", worktree: "/workspace", directory: "/workspace/sub" });
      expect((await client.session.diff({ sessionID: "ses_main", messageID: "msg_user" })).data).toMatchObject([{ file: "b.ts" }]);
      expect((await client.lsp.status()).data).toEqual([]);
      expect((await client.provider.auth()).data).toEqual({});
      expect(paths).toEqual([
        "GET /api/agent", "GET /api/command", "GET /api/fs/find?query=a&limit=50", "GET /api/vcs",
        "GET /api/vcs/diff?mode=working", "GET /api/project", "GET /api/location", "GET /api/location",
        "GET /api/session/ses_main/diff?from=msg_user",
      ]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("1.x calls the adapter does not port fail locally and never reach the engine", async () => {
    const originalFetch = globalThis.fetch;
    let reached = 0;
    globalThis.fetch = async () => { reached += 1; return new Response(null, { status: 204 }); };
    try {
      const client = createClientV2("http://owner.test/workspace/w/opencode2", "/workspace", {});
      const update = await client.config.update({ config: {} });
      expect(update.response?.status).toBe(501);
      expect(update.error).toMatchObject({ name: "UnsupportedInV2", message: "Not available on the OpenCode 2.x engine: /config" });
      expect((await client.mcp.connect({ name: "x" })).response?.status).toBe(501);
      expect((await client.instance.dispose()).response?.status).toBe(501);
      expect(reached).toBe(0);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test("v2 models keep their efforts so the effort picker lists them", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.endsWith("/api/model")) return jsonResponse({ data: [
      { id: "gpt-6-astra", providerID: "omnirush", name: "GPT 6 Astra", capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [{ id: "low", settings: { reasoningEffort: "low" } }, { id: "max", settings: { reasoningEffort: "max" } }] },
      { id: "plain", providerID: "omnirush", name: "Plain" },
    ] });
    if (request.url.endsWith("/api/provider")) return jsonResponse({ data: [{ id: "omnirush", name: "OmniRush" }] });
    if (request.url.endsWith("/api/model/default")) return jsonResponse({ data: {} });
    throw new Error(`Unexpected request: ${request.url}`);
  };
  try {
    const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
    const models = (await client.provider.list()).data?.all[0]?.models ?? {};
    expect(models["gpt-6-astra"]?.variants).toEqual({ low: { reasoningEffort: "low" }, max: { reasoningEffort: "max" } });
    expect(models["gpt-6-astra"]?.capabilities.reasoning).toBe(true);
    expect(models.plain?.variants).toBeUndefined();
    expect(models.plain?.capabilities.reasoning).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a send posts the picked effort with the session model", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.endsWith("/model")) { bodies.push(await request.json()); return new Response(null, { status: 204 }); }
    if (request.url.endsWith("/prompt")) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
  try {
    const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
    const model = { providerID: "omnirush", modelID: "gpt-6-astra" };
    await client.session.promptAsync({ sessionID: "ses_e", model, variant: "max", parts: [{ type: "text", text: "a" }] });
    await client.session.promptAsync({ sessionID: "ses_e", model, parts: [{ type: "text", text: "b" }] });
    expect(bodies).toEqual([
      { model: { providerID: "omnirush", id: "gpt-6-astra", variant: "max" } },
      { model: { providerID: "omnirush", id: "gpt-6-astra" } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stock mode sends no context of ours with a prompt", async () => {
  const originalFetch = globalThis.fetch;
  const globals = globalThis as { window?: unknown };
  const originalWindow = globals.window;
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    paths.push(new URL(request.url).pathname);
    return new Response(null, { status: 204 });
  };
  try {
    const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
    const send = () => client.session.promptAsync({ sessionID: "ses_s", model: { providerID: "omnirush", modelID: "gpt-6-astra" }, system: "Time zone: UTC", parts: [{ type: "text", text: "a" }] });
    await send();
    expect(paths.some((path) => path.includes("/instructions/entries/omnirush-context"))).toBe(true);
    paths.length = 0;
    globals.window = { __OMNIRUSH_ELECTRON__: { meta: { stockMode: true } } };
    await send();
    expect(paths).toEqual(["/opencode2/api/session/ses_s/model", "/opencode2/api/session/ses_s/prompt"]);
  } finally {
    globalThis.fetch = originalFetch;
    globals.window = originalWindow;
  }
});
