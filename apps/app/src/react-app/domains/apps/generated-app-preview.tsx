import { useMemo } from "react";
import type { GeneratedArtifactViewRevision, WorkflowArtifactPayload } from "@omnirush/types/workflows";
import { McpAppSandboxView } from "@/components/chat/mcp-app-frame";
import { useWorkspace } from "@/react-app/shell/workspace-provider";

const PREVIEW_ARGUMENTS = {};

/** Chat previews and dashboard apps use the same MCP renderer. */
export function GeneratedAppPreview({ html, payload, title, revision }: {
  html: string;
  payload: WorkflowArtifactPayload;
  title: string;
  revision: GeneratedArtifactViewRevision;
}) {
  const { omnirushServerClient, workspaceId } = useWorkspace();
  const resource = useMemo(() => ({
    serverName: "omnirush",
    toolName: `render_artifact_${revision.artifactViewId}`,
    resourceUri: revision.resourceUri,
    html,
    csp: revision.csp,
    prefersBorder: true,
  }), [html, revision]);
  const result = useMemo(() => ({ content: [], structuredContent: payload }), [payload]);
  if (!omnirushServerClient || !workspaceId) {
    return <p role="status" className="text-sm text-muted-foreground">Connect a workspace to open the preview.</p>;
  }
  return <McpAppSandboxView app={resource} toolName={title} inputArguments={PREVIEW_ARGUMENTS}
    result={result} unavailableNotice="This app could not open. Try reopening it, or ask OmniRush.ai to fix the preview."
    initialHeight={360} readOnly />;
}
