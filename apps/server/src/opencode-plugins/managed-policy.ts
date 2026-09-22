import { annotateShellOutput, check, checkManagedTool } from "./managed-policy-client.js";
import { applyEnginePath } from "./managed-policy-path.js";

type ToolBeforeInput = { tool: string; sessionID?: string; callID?: string };
type ToolAfterInput = { tool: string; sessionID?: string; callID?: string; args?: unknown };

export default async function managedPolicy(input?: { directory?: string }) {
  // Same tool directories the packaged app resolves for the server, applied
  // to the engine process so the bash tool finds git and gh in dev too.
  const enginePath = applyEnginePath();
  const directory = input?.directory;
  return {
    "tool.execute.before": async (event: ToolBeforeInput, output: { args: unknown }) =>
      checkManagedTool(event.tool, output.args, { directory, callID: event.callID, sessionID: event.sessionID }),
    "tool.execute.after": async (event: ToolAfterInput, output: { title: string; output: string; metadata: unknown }) => {
      if (event.tool !== "bash" && event.tool !== "shell") return;
      output.output = annotateShellOutput(event.callID, output.output);
    },
    "shell.env": async (_event: { cwd: string }, output: { env: Record<string, string> }) => {
      if (enginePath) output.env.PATH = enginePath;
    },
    "chat.params": async (input: { model: { providerID: string; id: string } }) => check("model", input.model),
  };
}
