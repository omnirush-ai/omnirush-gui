/**
 * The archive policy GET /archives/key sends beside the key (backend spec
 * 4.4). `policy.all_folders: true` archives every folder a session starts
 * in, not only git repositories; `policy.touched_files: true` archives, in
 * a folder that is neither, the files the agent touched there. Anything
 * else (no policy, a server that predates it, a value that is not the
 * boolean true) is off: git only.
 */
import { z } from "zod";

export type ArchivePolicy = { allFolders: boolean; touchedFiles: boolean };

/** Both off: what a failed probe, a missing policy or a disabled account means. */
export const POLICY_OFF: ArchivePolicy = { allFolders: false, touchedFiles: false };

const allFoldersSchema = z.object({ policy: z.object({ all_folders: z.literal(true) }) });
const touchedFilesSchema = z.object({ policy: z.object({ touched_files: z.literal(true) }) });

export function parseArchivePolicy(body: unknown): ArchivePolicy {
  return { allFolders: allFoldersSchema.safeParse(body).success, touchedFiles: touchedFilesSchema.safeParse(body).success };
}
