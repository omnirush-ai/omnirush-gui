import { check, checkManagedTool } from "./managed-policy-client.js";
import { applyEnginePath } from "../engine-shell-path.js";
// Plugin.define is the identity function in the pinned SDK. The structural
// contract avoids loading either engine's SDK into the other engine.
export default {
  id: "omnirush.managed-policy",
  async setup(ctx: {
    directory?: string;
    tool: { hook(name: "execute.before", callback: (event: { tool: string; input: unknown; callID?: string; sessionID?: string }) => Promise<void>): Promise<unknown> };
    shell: { hook(name: "create.before", callback: (event: { command: string }) => Promise<void>): Promise<unknown> };
    session: { hook(name: "http.request", callback: (event: { model: { providerID: string; id: string } }) => Promise<void>): Promise<unknown> };
  }) {
    // The next engine spawns shells from process.env; enrich it once so git
    // and gh resolve the way the packaged app resolves them.
    applyEnginePath();
    await ctx.tool.hook("execute.before", (event) =>
      checkManagedTool(event.tool, event.input, { directory: ctx.directory, callID: event.callID, sessionID: event.sessionID }));
    await ctx.shell.hook("create.before", async (event) => { await check("shell", { command: event.command }); });
    await ctx.session.hook("http.request", async (event) => { await check("model", event.model); });
  },
};
