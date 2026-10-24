import { ClaudeRuntime } from "./runtime.js";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { addRoute, type RequestContext, type Route } from "../routes/registry.js";
import { ApiError } from "../errors.js";
import type { WorkspaceInfo } from "../types.js";
import type { NativeUploadReceipt } from "./upload.js";

export function registerClaudeRoutes(input: {
  routes: Route[]; runtime: ClaudeRuntime;
  workspace: (ctx: RequestContext) => Promise<WorkspaceInfo>;
  owner: (ctx: RequestContext) => void;
  writable: () => void;
  upload: (sessionId: string) => Promise<NativeUploadReceipt>;
}) {
  const {runtime} = input;
  const register = (method: string, suffix: string, handler: (ctx: RequestContext, workspace: WorkspaceInfo) => Promise<Response>) => {
    addRoute(input.routes, method, `/workspace/:id/claude${suffix}`, "client", async ctx => {
      input.owner(ctx);
      if (method !== "GET") input.writable();
      const workspace = await input.workspace(ctx);
      if (ctx.params.session) {
        const session = await runtime.get(ctx.params.session);
        if (session.workspaceId !== workspace.id) throw new ApiError(404, "session_not_found", "Session not found in this workspace");
      }
      const response = await handler(ctx, workspace); response.headers.set("cache-control", "no-store"); return response;
    });
  };
  register("GET", "/status", async () => {
    try { return Response.json(await runtime.available()); }
    catch { return Response.json({allowed: false, sandboxReady: false}); }
  });
  register("POST", "/prepare", async ctx => { await runtime.prepare(ctx.request.signal); return Response.json({ready: true}); });
  register("GET", "/sessions", async (_, workspace) => Response.json(await runtime.list(workspace.id)));
  register("POST", "/sessions", async (ctx, workspace) => {
    const body = await ctx.request.json();
    if (body?.captureConsent !== true) throw new ApiError(400, "capture_consent_required", "Confirm private trace and environment capture");
    return Response.json(await runtime.create(workspace.path, workspace.id, ctx.request.signal), {status: 201});
  });
  register("GET", "/sessions/:session", async ctx => Response.json(await runtime.get(ctx.params.session)));
  register("GET", "/sessions/:session/events", async ctx => Response.json(await runtime.events(ctx.params.session)));
  register("POST", "/sessions/:session/turns", async ctx => {
    const body = await ctx.request.json();
    if (typeof body?.prompt !== "string") throw new ApiError(400, "prompt_required", "Enter a prompt");
    await runtime.start(ctx.params.session, body.prompt, ctx.request.signal); return Response.json({started: true}, {status: 202});
  });
  register("POST", "/sessions/:session/stop", async ctx => Response.json(await runtime.stop(ctx.params.session)));
  register("POST", "/sessions/:session/recover", async ctx => Response.json(await runtime.recover(ctx.params.session)));
  register("POST", "/sessions/:session/verify", async ctx => {
    const body = await ctx.request.json();
    if (body?.command !== undefined && (typeof body.command !== "string" || body.command.length > 10_000)) throw new ApiError(400, "invalid_command", "Invalid verification command");
    return Response.json(await runtime.verify(ctx.params.session, body?.command));
  });
  register("POST", "/sessions/:session/export", async ctx => {
    const file = await runtime.export(ctx.params.session);
    // The packaged desktop embeds the Node server; stream without Bun globals
    // or buffering a complete environment archive in the renderer/server heap.
    const stream = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
    return new Response(stream, {headers: {"content-type": "application/zip", "content-disposition": `attachment; filename="claude-${ctx.params.session}.zip"`}});
  });
  register("POST", "/sessions/:session/upload", async ctx => {
    return Response.json(await input.upload(ctx.params.session));
  });
}
