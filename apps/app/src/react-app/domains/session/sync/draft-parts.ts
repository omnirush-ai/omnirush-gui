import type {
  AgentPartInput,
  FilePartInput,
  TextPartInput,
} from "@opencode-ai/sdk/v2/client";

import type { ComposerDraft, ComposerPart } from "@/app/types";
import {
  composerAttachmentsToWorkspaceFileParts,
  type ChatAttachmentWorkspaceEndpoint,
} from "./attachment-file-part";
import {
  firstLineLocalFileParts,
  isReadInlineablePath,
  isWindowsWorkspaceRoot,
  joinWorkspaceRelativePath,
  promptFileUrl,
} from "./prompt-file-parts";
import { mentionPromptParts } from "./mention-parts";
import { parseConnectSkillToken } from "../surface/composer/connect-skill-token";
import { decodeComposerMentionValue } from "../surface/composer/mention-encoding";
import { defaultQuestion, draftRefs, refPromptText } from "../../work/ask/refs";

/** A draft's Work reference chips as the one note the agent reads first (synthetic: the bubble shows chips instead,
 *  rebuilt from `metadata.refs`). The brief line only when the visible text is the default question. */
export function refNotePart(draft: Pick<ComposerDraft, "parts" | "text">): (TextPartInput & { synthetic: true }) | null {
  const refs = draftRefs(draft);
  if (!refs.length) return null;
  return {
    type: "text",
    synthetic: true,
    metadata: { refs },
    text: refPromptText(refs, { brief: draft.text.trim() === defaultQuestion(refs) }),
  };
}

// All workspace-scoped server URLs/clients/tokens come from
// `resolveWorkspaceEndpoint` in apps/app/src/app/lib/workspace-endpoint.ts.
// Don't compose `<baseUrl>/workspace/<id>` here.
export async function draftToParts(
  draft: ComposerDraft,
  workspaceRoot: string,
  sessionId: string,
  endpoint: ChatAttachmentWorkspaceEndpoint | null,
) {
  const parts: Array<TextPartInput | FilePartInput | AgentPartInput> = [];
  const root = workspaceRoot.trim();
  const refNote = refNotePart(draft);
  if (refNote) parts.push(refNote);

  const toAbsolutePath = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return "";
    if (/^[a-zA-Z]:[\\/]/.test(trimmed) || /^(\\\\|\/\/)[^\\/]/.test(trimmed)) return trimmed;
    // On Windows a leading slash is not a full path; treat it as workspace-relative.
    if (trimmed.startsWith("/") && !isWindowsWorkspaceRoot(root)) return trimmed;
    if (!root) return "";
    return joinWorkspaceRelativePath(root, trimmed);
  };

  const filenameFromPath = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    const segments = normalized.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "file";
  };

  const attachmentFileById = new Map<string, FilePartInput>();
  if (draft.attachments.length > 0) {
    if (!endpoint) {
      throw new Error("Workspace endpoint is unavailable; attachments could not be copied for tool access.");
    }
    const uploaded = await composerAttachmentsToWorkspaceFileParts({
      attachments: draft.attachments,
      endpoint,
      sessionId,
      workspaceRoot: root,
    });
    if (uploaded) {
      parts.push(uploaded.note);
      for (const [index, attachment] of draft.attachments.entries()) {
        const filePart = uploaded.files[index];
        if (filePart) attachmentFileById.set(attachment.id, filePart);
      }
    }
  }

  // Prefer draft.text token order so attachment chips stay inline with surrounding text
  // (same positions as the composer), instead of dumping every file part at the end.
  const hasAttachmentTokens = /\[attachment [^\]]+\]/.test(draft.text);
  if (hasAttachmentTokens || attachmentFileById.size > 0) {
    const pasteByLabel = new Map(
      draft.parts
        .filter((part): part is Extract<ComposerPart, { type: "paste" }> => part.type === "paste")
        .map((part) => [part.label, part.text] as const),
    );
    const segments = draft.text.split(/(\[attachment [^\]]+\]|\[pasted text [^\]]+\]|\[connect-skill [^\]]+\]|\[skill [^\]]+\]|@[^\s@]+)/);
    for (const [index, segment] of segments.entries()) {
      if (!segment) continue;
      const attachmentMatch = segment.match(/^\[attachment (.+)\]$/);
      if (attachmentMatch?.[1]) {
        const filePart = attachmentFileById.get(attachmentMatch[1]);
        if (filePart) {
          parts.push(filePart);
          attachmentFileById.delete(attachmentMatch[1]);
        }
        continue;
      }
      const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
      if (pasteMatch?.[1]) {
        const pasted = pasteByLabel.get(pasteMatch[1]);
        if (pasted) parts.push({ type: "text", text: pasted });
        continue;
      }
      const connectSkill = parseConnectSkillToken(segment);
      if (connectSkill) {
        parts.push(...mentionPromptParts({ type: "connect-skill", ...connectSkill }));
        continue;
      }
      const skillMatch = segment.match(/^\[skill (.+)\]$/);
      if (skillMatch?.[1]) {
        parts.push(...mentionPromptParts({ type: "skill", name: skillMatch[1] }));
        continue;
      }
      if (segment.startsWith("@")) {
        const value = decodeComposerMentionValue(segment.slice(1));
        const mentionPart = draft.parts.find((part) =>
          (part.type === "agent" && part.name === value)
          || (part.type === "app" && part.name === value)
          || (part.type === "computer" && part.target === value
            && (index <= 1 && !segments[0] || /\s$/.test(segments[index - 1] ?? "")))
          || (part.type === "file" && part.path === value),
        );
        if (mentionPart?.type === "agent") {
          parts.push({ type: "agent", name: mentionPart.name });
          continue;
        }
        if (mentionPart?.type === "computer" || mentionPart?.type === "app") {
          parts.push(...mentionPromptParts(mentionPart));
          continue;
        }
        if (mentionPart?.type === "file") {
          const absolute = toAbsolutePath(mentionPart.path);
          const url = absolute ? promptFileUrl(absolute, root) : "";
          if (!absolute || !url || !isReadInlineablePath(absolute)) {
            parts.push({ type: "text", text: absolute || mentionPart.path });
            continue;
          }
          parts.push({
            type: "file",
            mime: "text/plain",
            url,
            filename: filenameFromPath(mentionPart.path),
          });
          continue;
        }
      }
      parts.push({ type: "text", text: segment });
    }
    for (const filePart of attachmentFileById.values()) {
      parts.push(filePart);
    }
  } else {
    for (const part of draft.parts) {
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "paste") {
        parts.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "agent") {
        parts.push({ type: "agent", name: part.name });
        continue;
      }
      if (part.type === "skill" || part.type === "connect-skill" || part.type === "computer" || part.type === "app") {
        parts.push(...mentionPromptParts(part));
        continue;
      }
      if (part.type === "file") {
        const absolute = toAbsolutePath(part.path);
        if (!absolute) continue;
        const url = promptFileUrl(absolute, root);
        if (!url || !isReadInlineablePath(absolute)) {
          parts.push({ type: "text", text: absolute });
          continue;
        }
        parts.push({
          type: "file",
          mime: "text/plain",
          url,
          filename: filenameFromPath(part.path),
        });
      }
    }
  }

  parts.push(...firstLineLocalFileParts(draft.resolvedText ?? draft.text, root));

  return parts;
}
