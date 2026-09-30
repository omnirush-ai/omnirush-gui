/**
 * OmniRush.ai's engine plugins on the opencode 2.x plugin API.
 *
 * The OmniRush.ai plugins (managed policy, browser tools, capabilities
 * knowledge, extensions, office/PDF attachments, spreadsheets, reasoning
 * effort, swarm, …) are written against the 1.x hook contract
 * (`tool.execute.before`, `experimental.chat.system.transform`,
 * `chat.params`, `chat.headers`, `chat.message`, `shell.env`, `event`, custom
 * `tool` definitions). The 2.x engine loads plugins of a different shape
 * (`export default {id, setup(ctx)}` with `ctx.tool.hook`, `ctx.session.hook`,
 * …) and no longer runs 1.x plugins at all. This module is the one 2.x plugin
 * the engine loads (from `<config dir>/plugins/`): it builds every OmniRush.ai
 * 1.x plugin with the 1.x factory input and bridges each 1.x hook onto its 2.x
 * counterpart, translating tool names and inputs (`shell`↔`bash`,
 * `subagent`↔`task`, `path`↔`filePath`) and message shapes both ways:
 *
 *   1.x hook                              2.x hook
 *   experimental.chat.system.transform    session "context" (system parts)
 *   experimental.chat.messages.transform  session "context" (messages; media parts as file parts)
 *   chat.params                           session "context" (options)
 *   chat.headers                          session "model.request" (headers)
 *   chat.message                          session "prompt" (a changed model → session.switchModel)
 *   tool.execute.before / .after          tool "execute.before" / "execute.after"
 *   tool.definition                       session "context" (tools: description)
 *   shell.env                             shell "create.before"
 *   event                                 1.x events from the engine adapter's `/event` stream
 *   tool: {name: {args, execute}}         tool.transform add (zod args as JSON Schema)
 *
 * The 1.x `client` the plugins receive is the 1.x SDK client on OmniRush.ai's
 * engine adapter (engine2/facade.ts), whose URL and credentials the server
 * hands the engine as OMNIRUSH_ENGINE_ADAPTER_URL / _AUTHORIZATION.
 */
import { createOpencodeClient } from "@opencode-ai/sdk";
import { z } from "zod";
import { v1ToolInput, v1ToolName, v2ToolInput } from "../engine2/shapes.js";
import * as ManagedPolicy from "./managed-policy.js";
import * as ChromeDevtools from "./omnirush-chrome-devtools.js";
import * as CapabilitiesKnowledge from "./omnirush-capabilities-knowledge.js";
import * as ExtensionsPreview from "./omnirush-extensions-preview.js";
import * as OfficeAttachments from "./omnirush-office-attachments.js";
import * as Spreadsheets from "./omnirush-spreadsheets.js";
import * as PdfAttachments from "./omnirush-pdf-attachments.js";
import * as AnthropicAdaptiveThinking from "./omnirush-anthropic-adaptive-thinking.js";
import * as AnthropicToolSchema from "./omnirush-anthropic-tool-schema.js";
import * as ReasoningEffort from "./omnirush-reasoning-effort.js";
import * as TitleRecovery from "./omnirush-title-recovery.js";
import * as Swarm from "./omnirush-swarm.js";

type Rec = Record<string, unknown>;
type Hook = (input: any, output: any) => Promise<void> | void;
type V1Tool = { description?: string; args?: Record<string, unknown>; execute: (args: any, context: any) => Promise<unknown> | unknown };
type V1Hooks = Record<string, unknown> & { tool?: Record<string, V1Tool>; event?: (input: { event: unknown }) => Promise<void> | void };

/** Registration order is prompt order (as in the 1.x engine config's plugin list). */
export const OMNIRUSH_V1_PLUGIN_MODULES: ReadonlyArray<Record<string, unknown>> = [
  ManagedPolicy,
  ChromeDevtools,
  CapabilitiesKnowledge,
  ExtensionsPreview,
  OfficeAttachments,
  Spreadsheets,
  PdfAttachments,
  AnthropicAdaptiveThinking,
  AnthropicToolSchema,
  ReasoningEffort,
  TitleRecovery,
  Swarm,
];

function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function adapterClient() {
  const baseUrl = process.env.OMNIRUSH_ENGINE_ADAPTER_URL?.trim();
  const authorization = process.env.OMNIRUSH_ENGINE_ADAPTER_AUTHORIZATION?.trim();
  if (!baseUrl) return undefined;
  return createOpencodeClient({ baseUrl, headers: authorization ? { authorization } : undefined });
}

async function adapterJson(path: string, directory: string): Promise<unknown> {
  const baseUrl = process.env.OMNIRUSH_ENGINE_ADAPTER_URL?.trim();
  if (!baseUrl) return undefined;
  const authorization = process.env.OMNIRUSH_ENGINE_ADAPTER_AUTHORIZATION?.trim();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { ...(authorization ? { authorization } : {}), "x-opencode-directory": encodeURIComponent(directory) },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

/** The text of a 2.x tool result (string or content list). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => (isRec(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [])).join("\n");
}

/** A 1.x tool return (`string` or `{title, output, metadata, attachments}`) as a 2.x tool result. */
export function v2ToolResult(value: unknown): { content: Array<Rec>; metadata?: Rec } {
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  if (!isRec(value)) return { content: [{ type: "text", text: value === undefined ? "" : JSON.stringify(value) }] };
  const output = typeof value.output === "string" ? value.output : JSON.stringify(value.output ?? "");
  const content: Rec[] = [{ type: "text", text: output }];
  for (const attachment of Array.isArray(value.attachments) ? value.attachments : []) {
    if (!isRec(attachment) || typeof attachment.url !== "string" || typeof attachment.mime !== "string") continue;
    content.push({ type: "file", uri: attachment.url, mime: attachment.mime, ...(typeof attachment.filename === "string" ? { name: attachment.filename } : {}) });
  }
  const metadata = isRec(value.metadata) ? { ...value.metadata } : {};
  if (typeof value.title === "string" && value.title) metadata.__title = value.title;
  return { content, ...(Object.keys(metadata).length ? { metadata } : {}) };
}

/** Zod raw shape (1.x tool `args`) as a JSON Schema object for the 2.x tool registry. */
export function argsJsonSchema(args: Record<string, unknown> | undefined): Rec {
  try {
    const schema = z.toJSONSchema(z.object((args ?? {}) as z.ZodRawShape), { io: "input", unrepresentable: "any" }) as Rec;
    delete schema.$schema;
    return schema;
  } catch {
    return { type: "object", properties: {}, additionalProperties: true };
  }
}

type AssetLike = { inline?: () => { mime: string; dataUrl: string } | undefined; mediaType?: string; constructor: new (input: unknown) => unknown };

/** 2.x model-request messages as 1.x-style messages whose media parts read as 1.x file parts. */
function messagesForV1(messages: unknown[]): { v1: Rec[]; restore: (edited: Rec[]) => unknown[] } {
  let AssetCtor: AssetLike["constructor"] | undefined;
  const originals = new Map<Rec, Rec>();
  const v1 = messages.map((message, index) => {
    if (!isRec(message) || !Array.isArray(message.content)) return { info: { id: `m${index}`, role: "system" }, content: [] } as Rec;
    const content = message.content.map((part) => {
      if (!isRec(part) || part.type !== "media" || !isRec(part.media)) return part;
      const asset = part.media as unknown as AssetLike;
      AssetCtor ??= asset.constructor;
      const inline = typeof asset.inline === "function" ? asset.inline() : undefined;
      if (!inline) return part;
      const file: Rec = { type: "file", mime: inline.mime, url: inline.dataUrl, ...(typeof part.filename === "string" ? { filename: part.filename } : {}) };
      originals.set(file, part);
      return file;
    });
    return { ...message, info: { id: `m${index}`, role: message.role }, content };
  });
  const toV2Part = (part: unknown): unknown => {
    if (!isRec(part)) return part;
    const original = originals.get(part);
    if (original) return original;
    if (part.type === "file" && typeof part.url === "string" && typeof part.mime === "string" && AssetCtor) {
      const match = part.url.match(/^data:([^;,]+);base64,(.*)$/s);
      if (!match) return { type: "text", text: `[file ${String(part.filename ?? part.url)}]` };
      const media = new AssetCtor({ source: { type: "base64", data: match[2], mediaType: match[1] } });
      return { type: "media", media, ...(typeof part.filename === "string" ? { filename: part.filename } : {}) };
    }
    if (part.type === "text" && typeof part.text === "string") {
      const { synthetic: _synthetic, id: _id, sessionID: _s, messageID: _m, ...rest } = part;
      return rest;
    }
    return part;
  };
  const restore = (edited: Rec[]) =>
    edited.map((message) => {
      if (!isRec(message)) return message;
      const { info: _info, parts, ...rest } = message;
      const content = Array.isArray(message.content) ? message.content : Array.isArray(parts) ? parts : [];
      return { ...rest, content: content.map(toV2Part) };
    });
  return { v1, restore };
}

type ModelInfo = Rec & { id: string; providerID: string };

export default {
  id: "omnirush",
  async setup(ctx: any) {
    const directory: string = ctx?.location?.directory ?? process.cwd();
    const client = adapterClient();
    const factoryInput = { client, directory, worktree: directory, project: { id: "omnirush", worktree: directory } };
    const plugins: V1Hooks[] = [];
    for (const module of OMNIRUSH_V1_PLUGIN_MODULES) {
      for (const factory of Object.values(module)) {
        if (typeof factory !== "function") continue;
        try {
          const hooks = await (factory as (input: unknown) => Promise<unknown>)(factoryInput);
          if (isRec(hooks)) plugins.push(hooks as V1Hooks);
        } catch (error) {
          console.error("[omnirush] plugin factory failed", error instanceof Error ? error.message : error);
        }
      }
    }
    const hooks = (name: string): Hook[] => plugins.flatMap((plugin) => (typeof plugin[name] === "function" ? [plugin[name] as Hook] : []));

    // 1.x model records for chat.params / chat.headers inputs (catalog read through the adapter, cached briefly).
    let catalog: { at: number; models: Map<string, ModelInfo> } | null = null;
    const modelInfo = async (ref: { providerID?: string; id?: string; variant?: string } | undefined): Promise<ModelInfo> => {
      const providerID = ref?.providerID ?? "";
      const id = ref?.id ?? "";
      if (!catalog || Date.now() - catalog.at > 30_000) {
        const payload = await adapterJson("/provider", directory);
        const models = new Map<string, ModelInfo>();
        for (const provider of isRec(payload) && Array.isArray(payload.all) ? payload.all : []) {
          if (!isRec(provider) || !isRec(provider.models)) continue;
          for (const model of Object.values(provider.models)) if (isRec(model) && typeof model.id === "string") models.set(`${provider.id}/${model.id}`, model as ModelInfo);
        }
        catalog = { at: Date.now(), models };
      }
      return catalog.models.get(`${providerID}/${id}`) ?? { id, providerID, api: { id, npm: "" }, capabilities: {} };
    };
    const hookInput = async (event: Rec) => {
      const ref = isRec(event.model) ? (event.model as { providerID?: string; id?: string; variant?: string }) : undefined;
      const model = await modelInfo(ref);
      const agent = event.kind === "title" ? "title" : event.kind === "compaction" ? "compaction" : String(event.agent ?? "");
      return {
        sessionID: String(event.sessionID ?? ""),
        agent,
        model,
        provider: { info: { id: model.providerID }, options: {} },
        message: { id: `${String(event.sessionID ?? "")}:turn`, sessionID: event.sessionID, model: { providerID: model.providerID, modelID: model.id, variant: ref?.variant } },
      };
    };

    // ---- custom tools ------------------------------------------------------
    const tools: Array<[string, V1Tool]> = plugins.flatMap((plugin) => (isRec(plugin.tool) ? Object.entries(plugin.tool as Record<string, V1Tool>) : []));
    // The 2.x engine has no todo list tool; the app's todo panel reads the 1.x one (`todowrite`).
    const todoItem = z.object({
      content: z.string().describe("Brief description of the task"),
      status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
      priority: z.string().describe("Priority level of the task: high, medium, low"),
      id: z.string().optional().describe("Unique identifier for the todo item"),
    });
    const todoArgs = { todos: z.array(todoItem).describe("The updated todo list") };
    tools.push(["todowrite", {
      description: "Use this tool to create and manage a structured task list for your current session. It helps you track progress on complex, multi-step work and shows the user what you are doing. Send the whole updated list every time; mark exactly one task in_progress while you work on it and mark tasks completed as soon as they are done.",
      args: todoArgs,
      async execute(raw: unknown, context: { sessionID?: string }) {
        const todos = z.object(todoArgs).parse(raw).todos;
        const baseUrl = process.env.OMNIRUSH_ENGINE_ADAPTER_URL?.trim();
        if (baseUrl && context?.sessionID) {
          const authorization = process.env.OMNIRUSH_ENGINE_ADAPTER_AUTHORIZATION?.trim();
          await fetch(`${baseUrl}/omnirush/todos`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
            body: JSON.stringify({ sessionID: context.sessionID, todos }),
            signal: AbortSignal.timeout(5_000),
          }).catch(() => undefined);
        }
        return { title: `${todos.filter((todo) => todo.status !== "completed").length} todos`, output: JSON.stringify(todos, null, 2), metadata: { todos } };
      },
    }]);

    if (tools.length > 0) {
      await ctx.tool.transform((editor: any) => {
        for (const [name, definition] of tools) {
          editor.add({
            name,
            description: definition.description ?? name,
            input: argsJsonSchema(definition.args),
            options: { codemode: false },
            execute: async (input: unknown, context: any) => {
              const result = await definition.execute(input ?? {}, {
                sessionID: context?.sessionID,
                messageID: context?.messageID,
                agent: context?.agent,
                callID: context?.id,
                abort: context?.signal ?? new AbortController().signal,
                directory,
                worktree: directory,
                metadata: (update: unknown) => {
                  if (isRec(update) && typeof context?.progress === "function") void context.progress(isRec(update.metadata) ? update.metadata : update);
                },
              });
              return v2ToolResult(result);
            },
          });
        }
      });
    }
    // The code-mode tool is never offered: tools are called directly, as with the 1.x engine.
    // MCP servers (also ones from a project's own opencode.json) default to direct tools.
    await ctx.tool.transform((editor: any) => {
      if (editor.get?.("execute")) editor.remove("execute");
    });
    if (typeof ctx.mcp?.transform === "function") {
      await ctx.mcp.transform((editor: any) => {
        for (const [, server] of editor.list() as Array<[string, Rec]>) {
          if (server.codemode === undefined) server.codemode = false;
        }
      });
    }

    // ---- tool calls --------------------------------------------------------
    // Sub-agents run in the foreground, as the 1.x task tool did (the swarm counts running
    // sub-agents and the task result carries the sub-agent's answer).
    await ctx.tool.hook("execute.before", async (event: any) => {
      if (event.tool !== "subagent" || !isRec(event.input)) return;
      // The sub-agent's model comes from the app's sub-agent setting (or the caller's), as with
      // the 1.x task tool, never from the model's own pick.
      const { model: _model, background: _background, ...input } = event.input;
      event.input = input;
    });
    // …so the subagent tool is offered without its `model` and `background` parameters.
    await ctx.session.hook("context", async (event: any) => {
      const input = event?.tools?.subagent?.input;
      if (!isRec(input) || !isRec(input.properties)) return;
      const { model: _model, background: _background, ...properties } = input.properties as Rec;
      event.tools.subagent.input = {
        ...input,
        properties,
        ...(Array.isArray(input.required) ? { required: input.required.filter((key: unknown) => key !== "model" && key !== "background") } : {}),
      };
    });
    const before = hooks("tool.execute.before");
    if (before.length) {
      await ctx.tool.hook("execute.before", async (event: any) => {
        const tool = v1ToolName(String(event.tool));
        const output = { args: v1ToolInput(String(event.tool), event.input) };
        for (const hook of before) await hook({ tool, sessionID: event.sessionID, callID: event.id, agent: event.agent }, output);
        event.input = v2ToolInput(tool, isRec(output.args) ? output.args : {});
      });
    }
    const after = hooks("tool.execute.after");
    if (after.length) {
      await ctx.tool.hook("execute.after", async (event: any) => {
        if (event.status !== "completed" || !isRec(event.result)) return;
        const tool = v1ToolName(String(event.tool));
        const original = resultText(event.result.content ?? event.result.output);
        const metadata: Rec = isRec(event.result.metadata) ? { ...event.result.metadata } : {};
        // The 1.x task tool named its child session `sessionId`.
        if (event.tool === "subagent" && typeof metadata.sessionID === "string" && metadata.sessionId === undefined) metadata.sessionId = metadata.sessionID;
        const output: { title: string; output: string; metadata: Rec } = { title: "", output: original, metadata };
        for (const hook of after) await hook({ tool, sessionID: event.sessionID, callID: event.id, args: v1ToolInput(String(event.tool), event.input) }, output);
        const files = Array.isArray(event.result.content) ? event.result.content.filter((item: unknown) => isRec(item) && item.type === "file") : [];
        event.result = {
          ...event.result,
          content: output.output === original && typeof event.result.content !== "undefined" ? event.result.content : [{ type: "text", text: output.output }, ...files],
          metadata: output.metadata,
        };
      });
    }

    // ---- shell env ---------------------------------------------------------
    const shellEnv = hooks("shell.env");
    if (shellEnv.length) {
      await ctx.shell.hook("create.before", async (event: any) => {
        const output = { env: { ...(isRec(event.env) ? event.env : {}) } };
        for (const hook of shellEnv) await hook({ cwd: event.cwd }, output);
        event.env = output.env;
      });
    }

    // ---- model request context: system prompt, messages, params -----------
    const systemHooks = hooks("experimental.chat.system.transform");
    const messageHooks = hooks("experimental.chat.messages.transform");
    const paramHooks = hooks("chat.params");
    if (systemHooks.length || messageHooks.length || paramHooks.length) {
      await ctx.session.hook("context", async (event: any) => {
        const input = await hookInput(event);
        if (systemHooks.length && Array.isArray(event.system)) {
          const parts = event.system as Rec[];
          const output = { system: parts.map((part) => (typeof part?.text === "string" ? part.text : "")) };
          for (const hook of systemHooks) await hook({ sessionID: input.sessionID, model: input.model }, output);
          event.system = output.system.map((text, index) => (parts[index] && parts[index]!.text === text ? parts[index] : { ...(parts[index] ?? {}), type: "text", text }));
        }
        if (messageHooks.length && Array.isArray(event.messages)) {
          const { v1, restore } = messagesForV1(event.messages);
          const output = { messages: v1 };
          // `agent` names title and compaction requests, which may run on another model.
          for (const hook of messageHooks) await hook({ sessionID: input.sessionID, model: input.model, agent: input.agent }, output);
          event.messages = restore(output.messages as Rec[]);
        }
        if (paramHooks.length && isRec(event.options)) {
          const options = event.options as Rec;
          const { temperature, topP, topK, ...rest } = options;
          const output: Rec & { options: Rec } = { temperature, topP, topK, options: { ...rest } };
          for (const hook of paramHooks) await hook(input, output);
          const next: Rec = { ...output.options };
          if (output.temperature !== undefined) next.temperature = output.temperature;
          if (output.topP !== undefined) next.topP = output.topP;
          if (output.topK !== undefined) next.topK = output.topK;
          event.options = next;
        }
      });
    }

    // Hooks OmniRush plugins offer for the 2.x engine only (the 1.x engine has no counterpart):
    // the real outgoing model request and its response, and each request's tool definitions.
    const httpRequestHooks = hooks("omnirush.http.request");
    const httpResponseHooks = hooks("omnirush.http.response");
    if (httpRequestHooks.length) {
      await ctx.session.hook("http.request", async (event: any) => {
        for (const hook of httpRequestHooks) await hook(event, event);
      });
    }
    if (httpResponseHooks.length) {
      await ctx.session.hook("http.response", async (event: any) => {
        for (const hook of httpResponseHooks) await hook(event, event);
      });
    }
    // 1.x `tool.definition` (a tool's description and parameters, per model request): the 2.x
    // engine offers each request's tools in the session "context" hook, under 2.x names.
    const definitionHooks = hooks("tool.definition");
    if (definitionHooks.length) {
      await ctx.session.hook("context", async (event: any) => {
        if (!isRec(event.tools)) return;
        for (const [name, tool] of Object.entries(event.tools as Record<string, unknown>)) {
          if (!isRec(tool) || typeof tool.description !== "string") continue;
          const output = { description: tool.description, parameters: tool.input };
          for (const hook of definitionHooks) await hook({ toolID: v1ToolName(name) }, output);
          if (output.description !== tool.description) tool.description = output.description;
        }
      });
    }
    const toolSchemaHooks = hooks("omnirush.tools.transform");
    if (toolSchemaHooks.length) {
      await ctx.session.hook("context", async (event: any) => {
        if (!isRec(event.tools)) return;
        const input = await hookInput(event);
        for (const hook of toolSchemaHooks) await hook({ sessionID: input.sessionID, model: input.model }, { tools: event.tools });
      });
    }

    const headerHooks = hooks("chat.headers");
    if (headerHooks.length) {
      await ctx.session.hook("model.request", async (event: any) => {
        const input = await hookInput(event);
        const output = { headers: { ...(isRec(event.headers) ? event.headers : {}) } as Record<string, string> };
        for (const hook of headerHooks) await hook(input, output);
        event.headers = output.headers;
      });
    }

    const messageCreated = hooks("chat.message");
    if (messageCreated.length) {
      await ctx.session.hook("prompt", async (event: any) => {
        const sessionID = String(event.sessionID ?? "");
        const info = await adapterJson(`/session/${encodeURIComponent(sessionID)}`, directory);
        // A new sub-agent session has no step yet: it runs on the model of the session above it.
        let current: { providerID: string; modelID: string; variant?: string } | undefined;
        let cursor: unknown = info;
        for (let hop = 0; hop < 5 && isRec(cursor); hop++) {
          if (isRec(cursor.model) && typeof cursor.model.id === "string") {
            current = { providerID: String(cursor.model.providerID), modelID: String(cursor.model.id), variant: typeof cursor.model.variant === "string" && cursor.model.variant !== "default" ? cursor.model.variant : undefined };
            break;
          }
          if (typeof cursor.parentID !== "string") break;
          cursor = await adapterJson(`/session/${encodeURIComponent(cursor.parentID)}`, directory);
        }
        const message: Rec = { id: event.messageID, sessionID, role: "user", model: current ? { ...current } : undefined };
        const agent = isRec(info) && typeof info.agent === "string" ? info.agent : undefined;
        for (const hook of messageCreated) {
          await hook({ sessionID, agent, model: current ? { providerID: current.providerID, modelID: current.modelID } : undefined, messageID: event.messageID, variant: current?.variant }, { message, parts: [] });
        }
        const chosen = isRec(message.model) ? message.model : undefined;
        if (chosen && typeof chosen.providerID === "string" && typeof chosen.modelID === "string"
          && (!current || chosen.providerID !== current.providerID || chosen.modelID !== current.modelID || (chosen.variant ?? undefined) !== current.variant)) {
          await ctx.session.switchModel({
            sessionID,
            model: { providerID: chosen.providerID, id: chosen.modelID, ...(typeof chosen.variant === "string" && chosen.variant ? { variant: chosen.variant } : {}) },
          }).catch((error: unknown) => console.error("[omnirush] model switch failed", error instanceof Error ? error.message : error));
        }
      });
    }

    // ---- tool listing: the adapter answers 1.x `/experimental/tool[/ids]` from this report ----
    let reportedTools = "";
    const reportTools = async () => {
      const baseUrl = process.env.OMNIRUSH_ENGINE_ADAPTER_URL?.trim();
      if (!baseUrl || typeof ctx.tool?.list !== "function") return;
      try {
        const list = (await ctx.tool.list()) as Array<Rec & { id: string }>;
        const tools = list
          .map((tool) => ({
            id: v1ToolName(String(tool.id ?? tool.name ?? "")),
            description: typeof tool.description === "string" ? tool.description : "",
            parameters: isRec(tool.input) && typeof (tool.input as Rec).type === "string" ? tool.input : {},
          }))
          .filter((tool) => tool.id && tool.id !== "execute")
          .sort((left, right) => left.id.localeCompare(right.id));
        const key = JSON.stringify(tools.map((tool) => tool.id));
        if (key === reportedTools) return;
        const authorization = process.env.OMNIRUSH_ENGINE_ADAPTER_AUTHORIZATION?.trim();
        const response = await fetch(`${baseUrl}/omnirush/engine-tools`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
          body: JSON.stringify({ directory, tools }),
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) reportedTools = key;
      } catch {
        // Reported again on the next tick.
      }
    };
    await reportTools();
    const toolTimer = setInterval(() => void reportTools(), 3_000);
    toolTimer.unref?.();

    // ---- events: the 1.x stream of the engine adapter ---------------------
    const eventHooks = plugins.flatMap((plugin) => (typeof plugin.event === "function" ? [plugin.event] : []));
    const controller = new AbortController();
    if (eventHooks.length && process.env.OMNIRUSH_ENGINE_ADAPTER_URL) {
      void (async () => {
        const baseUrl = process.env.OMNIRUSH_ENGINE_ADAPTER_URL!.trim();
        const authorization = process.env.OMNIRUSH_ENGINE_ADAPTER_AUTHORIZATION?.trim();
        while (!controller.signal.aborted) {
          try {
            const response = await fetch(`${baseUrl}/event`, {
              headers: { ...(authorization ? { authorization } : {}), accept: "text/event-stream", "x-opencode-directory": encodeURIComponent(directory) },
              signal: controller.signal,
            });
            if (!response.ok || !response.body) throw new Error(`event stream ${response.status}`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              let index: number;
              while ((index = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
                if (!data) continue;
                let event: unknown;
                try {
                  event = JSON.parse(data);
                } catch {
                  continue;
                }
                for (const hook of eventHooks) {
                  try {
                    await hook!({ event });
                  } catch (error) {
                    console.error("[omnirush] plugin event hook failed", error instanceof Error ? error.message : error);
                  }
                }
              }
            }
          } catch {
            if (controller.signal.aborted) return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      })();
    }

    return async () => {
      clearInterval(toolTimer);
      controller.abort();
      for (const plugin of plugins) {
        const dispose = plugin.dispose;
        if (typeof dispose === "function") await Promise.resolve((dispose as () => unknown)()).catch(() => undefined);
      }
    };
  },
};
