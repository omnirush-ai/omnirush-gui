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

export type ArchivePolicy = {
  allFolders: boolean;
  touchedFiles: boolean;
  captureV2?: boolean;
  projectFolders?: boolean;
  /**
   * Files used (files-used.ts, backend spec 19.7): the server's flag is on
   * and the user acknowledged the consent line; with the server's caps when
   * it sends them (null there: the client's own caps apply).
   */
  filesUsed?: boolean;
  filesUsedMaxFileBytes?: number;
  filesUsedMaxSessionBytes?: number;
  /** The server's flag alone, whether the user accepted, and the consent line to show (null while the flag is off). */
  filesUsedAvailable?: boolean;
  filesUsedAccepted?: boolean;
  filesUsedConsentText?: string;
  /** The server's rules switch (`policy.redaction_v3`): the uploader uses the client-v3 rules (context/redact-policy.ts). */
  redactionV3?: boolean;
};

/** Both off: what a failed probe, a missing policy or a disabled account means. */
export const POLICY_OFF: ArchivePolicy = { allFolders: false, touchedFiles: false };

const allFoldersSchema = z.object({ policy: z.object({ all_folders: z.literal(true) }) });
const touchedFilesSchema = z.object({ policy: z.object({ touched_files: z.literal(true) }) });
/** Capture v2 (capture-v2.ts): the server takes the byte-exact state archives. */
/** A git-less project folder (detect.ts `looksLikeProject`) is archived whole, marker `project`. */
const projectFoldersSchema = z.object({ policy: z.object({ project_folders: z.literal(true) }) });
const captureV2Schema = z.object({ policy: z.object({ capture_v2: z.literal(true) }) });
const redactionV3Schema = z.object({ policy: z.object({ redaction_v3: z.literal(true) }) });
/** Files used (19.7): each state lists the files the turn used; the caps travel with it. */
const filesUsedSchema = z.object({ policy: z.object({ files_used: z.literal(true) }) });
const capSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const filesUsedCapsSchema = z.object({ policy: z.object({ files_used_max_file_bytes: capSchema.nullish(), files_used_max_session_bytes: capSchema.nullish() }) });
const filesUsedConsentSchema = z.object({
  policy: z.object({
    files_used_available: z.boolean().optional(),
    files_used_accepted: z.boolean().optional(),
    files_used_consent_text: z.string().max(4_096).nullish(),
  }),
});

export function parseArchivePolicy(body: unknown): ArchivePolicy {
  return {
    allFolders: allFoldersSchema.safeParse(body).success,
    touchedFiles: touchedFilesSchema.safeParse(body).success,
    // Present only when on: a policy without it reads exactly as before.
    ...(captureV2Schema.safeParse(body).success ? { captureV2: true } : {}),
    ...(projectFoldersSchema.safeParse(body).success ? { projectFolders: true } : {}),
    ...(redactionV3Schema.safeParse(body).success ? { redactionV3: true } : {}),
    ...(filesUsedSchema.safeParse(body).success ? { filesUsed: true, ...filesUsedCaps(body) } : {}),
    ...filesUsedConsent(body),
  };
}

function filesUsedConsent(body: unknown): Pick<ArchivePolicy, "filesUsedAvailable" | "filesUsedAccepted" | "filesUsedConsentText"> {
  const consent = filesUsedConsentSchema.safeParse(body);
  if (!consent.success) return {};
  const { files_used_available: available, files_used_accepted: accepted, files_used_consent_text: text } = consent.data.policy;
  return {
    ...(available !== undefined ? { filesUsedAvailable: available } : {}),
    ...(accepted !== undefined ? { filesUsedAccepted: accepted } : {}),
    ...(text ? { filesUsedConsentText: text } : {}),
  };
}

function filesUsedCaps(body: unknown): Pick<ArchivePolicy, "filesUsedMaxFileBytes" | "filesUsedMaxSessionBytes"> {
  const caps = filesUsedCapsSchema.safeParse(body);
  if (!caps.success) return {};
  const { files_used_max_file_bytes: file, files_used_max_session_bytes: session } = caps.data.policy;
  return { ...(file ? { filesUsedMaxFileBytes: file } : {}), ...(session ? { filesUsedMaxSessionBytes: session } : {}) };
}
