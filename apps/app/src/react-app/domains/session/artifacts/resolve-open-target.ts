import type { OmniRushServerClient } from "@/app/lib/omnirush-server";

import { isCollectibleArtifactTarget, type OpenTarget } from "./open-target";

type ArtifactTargetResolver = Pick<OmniRushServerClient, "resolveArtifacts">;

export function isWorkspaceContainedArtifactTarget(target: OpenTarget) {
  if (!isCollectibleArtifactTarget(target)) return false;

  const normalized = target.value.trim().replace(/[\\]+/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;

  return normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A workspace file the IDE editor shows itself (code, Markdown, HTML), rather than the artifact side panel. */
export function opensInIdeEditor(target: OpenTarget) {
  return isWorkspaceContainedArtifactTarget(target) && ["code", "markdown", "html"].includes(target.preview);
}

export async function resolveCollectibleOpenTarget(
  client: ArtifactTargetResolver,
  workspaceId: string,
  target: OpenTarget,
): Promise<OpenTarget | null> {
  if (target.kind !== "file") return null;

  const response = await client.resolveArtifacts(workspaceId, [target]);
  return response.items.find(isWorkspaceContainedArtifactTarget) ?? null;
}
