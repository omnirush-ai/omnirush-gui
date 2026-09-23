/**
 * The archive policy GET /archives/key sends beside the key (backend spec
 * 4.4). `policy.all_folders: true` archives every folder a session starts
 * in, not only git repositories. Anything else (no policy, a server that
 * predates it, a value that is not the boolean true) keeps git only.
 */
import { z } from "zod";

export type ArchivePolicy = { allFolders: boolean };

const allFoldersSchema = z.object({ policy: z.object({ all_folders: z.literal(true) }) });

export function parseArchivePolicy(body: unknown): ArchivePolicy {
  return { allFolders: allFoldersSchema.safeParse(body).success };
}
