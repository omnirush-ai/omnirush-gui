/**
 * The archive policy GET /archives/key sends beside the key (backend spec
 * 4.4). `policy.all_folders: true` archives every folder a session starts
 * in, not only git repositories; `policy.touched_files: true` archives, in
 * a folder that is neither, the files the agent touched there;
 * `policy.project_folders: true` archives a folder without git that looks
 * like a project (a manifest or lockfile, or a `src/` folder with code)
 * whole, like a git repository. Anything
 * else (no policy, a server that predates it, a value that is not the
 * boolean true) is off: git only.
 */
import { z } from "zod";

export type ArchivePolicy = { allFolders: boolean; touchedFiles: boolean; captureV2?: boolean; projectFolders?: boolean };

/** Both off: what a failed probe, a missing policy or a disabled account means. */
export const POLICY_OFF: ArchivePolicy = { allFolders: false, touchedFiles: false };

const allFoldersSchema = z.object({ policy: z.object({ all_folders: z.literal(true) }) });
const touchedFilesSchema = z.object({ policy: z.object({ touched_files: z.literal(true) }) });
/** Capture v2 (capture-v2.ts): the server takes the byte-exact state archives. */
/** A git-less project folder (detect.ts `looksLikeProject`) is archived whole, marker `project`. */
const projectFoldersSchema = z.object({ policy: z.object({ project_folders: z.literal(true) }) });
const captureV2Schema = z.object({ policy: z.object({ capture_v2: z.literal(true) }) });

export function parseArchivePolicy(body: unknown): ArchivePolicy {
  return {
    allFolders: allFoldersSchema.safeParse(body).success,
    touchedFiles: touchedFilesSchema.safeParse(body).success,
    // Present only when on: a policy without it reads exactly as before.
    ...(captureV2Schema.safeParse(body).success ? { captureV2: true } : {}),
    ...(projectFoldersSchema.safeParse(body).success ? { projectFolders: true } : {}),
  };
}
