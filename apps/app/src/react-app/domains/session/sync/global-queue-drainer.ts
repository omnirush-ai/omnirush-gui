import type { SessionStatus } from "@opencode-ai/sdk/v2/client";

import { markTaskRunStart } from "@/app/lib/analytics";
import { createClient, createPromptMessageID, hasAcceptedPromptMessage, isPromptAdmissionUnknown } from "@/app/lib/opencode";
import { shellInSession } from "@/app/lib/opencode-session";
import { submitAfterInterruption } from "@/app/lib/opencode-interruption";
import { createClientV2, isOpencodeV2BaseUrl } from "@/app/lib/opencode-v2-adapter";
import { composeNativeSessionSnapshot } from "@/app/lib/opencode-session-native";
import { parseGoalInvocation } from "@/app/lib/session-goal";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { OmniRushServerError } from "@/app/lib/omnirush-server";
import type { ComposerDraft, ModelRef } from "@/app/types";
import { readStoredDefaultModel } from "@/react-app/kernel/model-config";
import { useSessionActivityStore } from "../status/session-activity-store";
import {
  getComposerQueuedDrafts,
  useComposerStateStore,
} from "../surface/composer-state-store";
import {
  canAdmitNextQueuedItem,
  assertQueuedSendCurrent,
  claimQueuedSend,
  dispatchQueuedDrain,
  getQueuedDrainState,
  getQueuedSendGeneration,
  nextObservationProbeAt,
  subscribeQueuedDrain,
} from "../surface/queued-drain-machine";
import { getSessionModelSelection, useSessionModelStore } from "../surface/session-model-store";
import { draftToParts } from "./draft-parts";
import { buildOmniRushSessionSystemContext } from "./env-context";
import {
  clearQueuedSendContext,
  getQueuedSendContext,
  getQueuedSendContextSessionIds,
  subscribeQueuedSendContext,
  type QueuedSendContext,
} from "./queued-send-context";
import { ensureWorkspaceSessionSync, trackWorkspaceSessionSync } from "./session-sync";

type WatchedSession = {
  sessionId: string;
  context: QueuedSendContext;
  releaseWorkspaceSync: () => void;
  releaseSessionSync: () => void;
  unsubscribeDrain: () => void;
  initialStatusController: AbortController;
  probeController: AbortController | null;
  probeTimer: ReturnType<typeof setTimeout> | null;
  lastObservedStatus: SessionStatus | null;
  lastProbeAt: number | null;
  probeInFlight: boolean;
  sendInFlight: boolean;
  holdActive: boolean;
  holdTimer: ReturnType<typeof setInterval> | null;
  holdWrite: Promise<void>;
  holdGeneration: number;
};

const watchedSessions = new Map<string, WatchedSession>();
const holdWrites = new Map<string, Promise<void>>();
let startRefs = 0;
let unsubscribeComposerStore: (() => void) | null = null;
let unsubscribeContexts: (() => void) | null = null;

function sessionNeedsGoalHold(sessionId: string, sendInFlight = false) {
  const phase = getQueuedDrainState(sessionId).phase.kind;
  return getComposerQueuedDrafts(useComposerStateStore.getState(), sessionId).length > 0
    || sendInFlight || phase === "sending" || phase === "admission_unknown";
}

function writeGoalHold(watched: WatchedSession, holding: boolean) {
  const { context, sessionId } = watched;
  const key = JSON.stringify([context.client.baseUrl, context.workspaceId, sessionId]);
  const previous = holdWrites.get(key) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    await context.client.commandSessionGoal(context.workspaceId, sessionId, { action: "hold", holding });
  }).catch((error: unknown) => {
    // An older remote server cannot run goals and has no hold endpoint.
    if (error instanceof OmniRushServerError && error.status === 404) return;
    throw error;
  });
  holdWrites.set(key, task);
  void task.catch(() => {}).finally(() => {
    if (holdWrites.get(key) === task) holdWrites.delete(key);
  });
  return task;
}

export async function waitForQueuedGoalHold(sessionId: string) {
  let watched = watchedSessions.get(sessionId);
  while (watched?.holdActive) {
    await watched.holdWrite;
    if (watchedSessions.get(sessionId) === watched) return;
    watched = watchedSessions.get(sessionId);
  }
}

function sameContext(left: QueuedSendContext, right: QueuedSendContext) {
  return left.workspaceId === right.workspaceId
    && left.workspaceRoot === right.workspaceRoot
    && left.opencodeBaseUrl === right.opencodeBaseUrl
    && left.omnirushToken === right.omnirushToken
    && left.client === right.client
    && left.agent === right.agent
    && left.variant === right.variant
    && left.model?.providerID === right.model?.providerID
    && left.model?.modelID === right.model?.modelID
    && left.environmentRuntimeKey === right.environmentRuntimeKey;
}

function serializeSDKError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    try {
      const serialized = JSON.stringify(error);
      if (serialized) return serialized;
    } catch {
      const message = Reflect.get(error, "message");
      return typeof message === "string" ? message : String(error);
    }
  }
  return String(error);
}

function readStoredDefaultModelSafely(): ModelRef | null {
  try {
    return readStoredDefaultModel();
  } catch {
    return null;
  }
}

async function performQueuedDraftSend(
  context: QueuedSendContext,
  sessionId: string,
  draft: ComposerDraft,
  generation: number,
) {
  assertQueuedSendCurrent(sessionId, generation);
  const text = draft.text.trim();
  if (!text && draft.attachments.length === 0 && !draft.command) return;

  const sessionModelSelection = getSessionModelSelection(sessionId);
  const sendModel = sessionModelSelection?.model ?? readStoredDefaultModelSafely() ?? context.model;
  const sendVariant = sessionModelSelection ? sessionModelSelection.variant : context.variant;
  const goalInvocation = draft.mode === "prompt" ? parseGoalInvocation(text) : null;
  if (goalInvocation) {
    if (goalInvocation.action === "edit") {
      throw new Error("Open this conversation to edit its goal.");
    }
    if (goalInvocation.action === "status") {
      await context.client.getSessionGoal(context.workspaceId, sessionId);
    } else {
      if (goalInvocation.action === "set") {
        const { goal } = await context.client.getSessionGoal(context.workspaceId, sessionId);
        if (goal && goal.status !== "complete") throw new Error("Open this conversation to confirm replacing its goal.");
      }
      await context.client.commandSessionGoal(context.workspaceId, sessionId, {
        action: goalInvocation.action,
        ...(goalInvocation.action === "set" ? { objective: goalInvocation.objective } : {}),
        model: sendModel ?? undefined,
        agent: context.agent ?? undefined,
        variant: sendVariant ?? undefined,
      });
    }
    await getReactQueryClient().invalidateQueries({ queryKey: ["session-goal", context.client.baseUrl, context.workspaceId, sessionId] });
    return;
  }
  const createEngineClient = isOpencodeV2BaseUrl(context.opencodeBaseUrl) ? createClientV2 : createClient;
  const opencodeClient = createEngineClient(
    context.opencodeBaseUrl,
    context.workspaceRoot || undefined,
    { token: context.omnirushToken, mode: "omnirush" },
  );

  if (draft.mode === "shell") {
    await shellInSession(opencodeClient, sessionId, text, { messageID: draft.messageId });
    return;
  }

  if (draft.command) {
    const result = await opencodeClient.session.command({
      sessionID: sessionId,
      messageID: draft.messageId,
      command: draft.command.name,
      arguments: draft.command.arguments,
    });
    if (result.error) throw new Error(serializeSDKError(result.error));
    return;
  }

  const parts = await draftToParts(draft, context.workspaceRoot, sessionId, {
    client: context.client,
    workspaceId: context.workspaceId,
  });
  assertQueuedSendCurrent(sessionId, generation);
  const system = await buildOmniRushSessionSystemContext(context.client, {
    workspaceId: context.workspaceId,
    cacheKey: sessionId,
    runtimeKey: context.environmentRuntimeKey,
  });
  assertQueuedSendCurrent(sessionId, generation);
  const result = await opencodeClient.session.promptAsync({
    sessionID: sessionId,
    messageID: draft.messageId,
    parts,
    model: sendModel ?? undefined,
    agent: context.agent ?? undefined,
    ...(sendVariant ? { variant: sendVariant } : {}),
    system,
  });
  if (result.error) {
    if (isPromptAdmissionUnknown(result.error)) throw result.error;
    throw new Error(serializeSDKError(result.error));
  }
  assertQueuedSendCurrent(sessionId, generation);
  if (sendModel) {
    useSessionModelStore.getState().setModel(sessionId, sendModel, sendVariant ?? null);
  }
}

// Mirrors withoutRevertTarget in ../surface/session-surface.tsx without
// importing the component module.
function withoutRevertTarget(draft: ComposerDraft): ComposerDraft {
  if (!draft.revertMessageId) return draft;
  return { ...draft, revertMessageId: undefined };
}

// Mirrors revokeAttachmentPreview in ../surface/session-surface.tsx, with a
// guard for app-less/node execution.
function revokeAttachmentPreview(attachment: { previewUrl?: string }) {
  if (!attachment.previewUrl || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(attachment.previewUrl);
}

function armObservationProbe(watched: WatchedSession) {
  if (watchedSessions.get(watched.sessionId) !== watched) return;
  if (watched.probeTimer !== null) {
    clearTimeout(watched.probeTimer);
    watched.probeTimer = null;
  }
  if (watched.probeInFlight) return;

  const probeAt = nextObservationProbeAt(
    getQueuedDrainState(watched.sessionId),
    watched.lastProbeAt,
  );
  if (probeAt === null) return;

  watched.probeTimer = setTimeout(() => {
    watched.probeTimer = null;
    const startedAt = Date.now();
    watched.lastProbeAt = startedAt;
    watched.probeInFlight = true;
    const controller = new AbortController();
    watched.probeController = controller;
    void (async () => {
      const phase = getQueuedDrainState(watched.sessionId).phase;
      if (phase.kind === "admission_unknown") {
        const client = createClient(watched.context.opencodeBaseUrl, watched.context.workspaceRoot || undefined, {
          token: watched.context.omnirushToken, mode: "omnirush",
        });
        if (await hasAcceptedPromptMessage(client, watched.sessionId, phase.messageID)) {
          if (watchedSessions.get(watched.sessionId) !== watched) return;
          dispatchQueuedDrain(watched.sessionId, {
            type: "admission_observed", itemId: phase.itemId, messageID: phase.messageID, at: Date.now(),
          });
        }
        return;
      }
      const snapshot = await composeNativeSessionSnapshot(
        {
          opencodeBaseUrl: watched.context.opencodeBaseUrl,
          token: watched.context.omnirushToken,
        },
        watched.sessionId,
        { limit: 140, signal: controller.signal },
      );
      if (watchedSessions.get(watched.sessionId) !== watched) return;
      watched.lastObservedStatus = snapshot.status;
      if (snapshot.status.type === "idle") {
        dispatchQueuedDrain(watched.sessionId, {
          type: "idle_reconciled",
          observedAt: startedAt,
        });
      } else {
        dispatchQueuedDrain(watched.sessionId, { type: "busy_observed" });
      }
    })().catch(() => {
      // A spaced retry is armed below from the machine's timing helper.
    }).finally(() => {
      if (watchedSessions.get(watched.sessionId) !== watched) return;
      watched.probeInFlight = false;
      watched.probeController = null;
      armObservationProbe(watched);
    });
  }, Math.max(0, probeAt - Date.now()));
}

function handleObservedStatus(watched: WatchedSession, status: SessionStatus) {
  if (watchedSessions.get(watched.sessionId) !== watched) return;
  watched.lastObservedStatus = status;
  if (status.type !== "idle") {
    dispatchQueuedDrain(watched.sessionId, { type: "busy_observed" });
    return;
  }
  if (getQueuedDrainState(watched.sessionId).phase.kind === "running") {
    dispatchQueuedDrain(watched.sessionId, {
      type: "idle_reconciled",
      observedAt: Date.now(),
    });
  }
  void attemptDrain(watched.sessionId);
}

function releaseWatchedSession(watched: WatchedSession, clearContext: boolean) {
  if (watchedSessions.get(watched.sessionId) === watched) {
    watchedSessions.delete(watched.sessionId);
  }
  if (watched.probeTimer !== null) clearTimeout(watched.probeTimer);
  if (watched.holdTimer !== null) clearInterval(watched.holdTimer);
  if (watched.holdActive) {
    watched.holdActive = false;
    void writeGoalHold(watched, false).catch(() => {});
  }
  watched.initialStatusController.abort();
  watched.probeController?.abort();
  watched.unsubscribeDrain();
  watched.releaseSessionSync();
  watched.releaseWorkspaceSync();
  if (clearContext) clearQueuedSendContext(watched.sessionId);
}

function watchSession(sessionId: string, context: QueuedSendContext) {
  const initialStatusController = new AbortController();
  const watched: WatchedSession = {
    sessionId,
    context,
    releaseWorkspaceSync: () => {},
    releaseSessionSync: () => {},
    unsubscribeDrain: () => {},
    initialStatusController,
    probeController: null,
    probeTimer: null,
    lastObservedStatus: null,
    lastProbeAt: null,
    probeInFlight: false,
    sendInFlight: false,
    holdActive: true,
    holdTimer: null,
    holdWrite: Promise.resolve(),
    holdGeneration: getQueuedSendGeneration(sessionId),
  };
  const input = {
    workspaceId: context.workspaceId,
    baseUrl: context.opencodeBaseUrl,
    omnirushToken: context.omnirushToken,
    onSessionStatus: (update: { sessionId: string; status: SessionStatus }) => {
      if (update.sessionId === sessionId) handleObservedStatus(watched, update.status);
    },
  };
  watched.releaseWorkspaceSync = ensureWorkspaceSessionSync(input);
  watched.releaseSessionSync = trackWorkspaceSessionSync(input, sessionId);
  watchedSessions.set(sessionId, watched);
  watched.holdWrite = writeGoalHold(watched, true);
  void watched.holdWrite.catch(() => {});
  watched.holdTimer = setInterval(() => {
    if (watchedSessions.get(sessionId) !== watched || !sessionNeedsGoalHold(sessionId, watched.sendInFlight)) return;
    watched.holdWrite = writeGoalHold(watched, true);
    void watched.holdWrite.catch(() => {});
  }, 5_000);
  watched.unsubscribeDrain = subscribeQueuedDrain(sessionId, () => {
    if (getQueuedSendGeneration(sessionId) !== watched.holdGeneration) {
      releaseWatchedSession(watched, true);
      return;
    }
    reconcileWatchedSessions();
    if (watchedSessions.get(sessionId) !== watched) return;
    armObservationProbe(watched);
    if (watched.lastObservedStatus?.type === "idle") void attemptDrain(sessionId);
  });
  armObservationProbe(watched);

  void composeNativeSessionSnapshot(
    { opencodeBaseUrl: context.opencodeBaseUrl, token: context.omnirushToken },
    sessionId,
    { limit: 140, signal: initialStatusController.signal },
  ).then((snapshot) => {
    handleObservedStatus(watched, snapshot.status);
  }).catch(() => {
    // The live workspace stream remains authoritative if this initial read fails.
  });
}

function reconcileWatchedSessions() {
  if (startRefs === 0) return;
  const queuedDrafts = useComposerStateStore.getState().queuedDrafts;

  for (const [sessionId, watched] of [...watchedSessions]) {
    const queuedItems = queuedDrafts[sessionId] ?? [];
    const context = getQueuedSendContext(sessionId);
    if (!sessionNeedsGoalHold(sessionId, watched.sendInFlight) || !context) {
      releaseWatchedSession(watched, queuedItems.length === 0);
      continue;
    }
    if (!sameContext(watched.context, context)) {
      releaseWatchedSession(watched, false);
      watchSession(sessionId, context);
    }
  }

  for (const sessionId of getQueuedSendContextSessionIds()) {
    if (!sessionNeedsGoalHold(sessionId) || watchedSessions.has(sessionId)) continue;
    const context = getQueuedSendContext(sessionId);
    if (context) watchSession(sessionId, context);
  }

  for (const [sessionId] of [...watchedSessions]) void attemptDrain(sessionId);
}

async function attemptDrain(sessionId: string) {
  const watched = watchedSessions.get(sessionId);
  if (!watched || watched.sendInFlight) return;
  const context = getQueuedSendContext(sessionId);
  const nextItem = getComposerQueuedDrafts(useComposerStateStore.getState(), sessionId)[0];
  if (!context || !nextItem || watched.lastObservedStatus?.type !== "idle") return;
  if (!canAdmitNextQueuedItem(getQueuedDrainState(sessionId))) return;

  const draft = { ...withoutRevertTarget(nextItem.draft), messageId: nextItem.draft.messageId ?? createPromptMessageID() };
  // Claim synchronously before any await so a mounted surface cannot win the
  // same item after this drainer observes it.
  if (!claimQueuedSend(sessionId, nextItem.id)) return;
  const generation = getQueuedSendGeneration(sessionId);
  watched.sendInFlight = true;
  useComposerStateStore.getState().removeQueuedDraft(sessionId, nextItem.id);

  try {
    await waitForQueuedGoalHold(sessionId);
    await submitAfterInterruption(context.opencodeBaseUrl, sessionId,
      () => performQueuedDraftSend(context, sessionId, draft, generation), draft.messageId);
    const goalInvocation = draft.mode === "prompt" ? parseGoalInvocation(draft.text) : null;
    if (goalInvocation && goalInvocation.action !== "set" && goalInvocation.action !== "resume") {
      dispatchQueuedDrain(sessionId, { type: "control_completed", itemId: nextItem.id });
    } else {
      dispatchQueuedDrain(sessionId, {
        type: "send_result",
        itemId: nextItem.id,
        outcome: "sent",
        at: Date.now(),
      });
    }
    draft.attachments.forEach(revokeAttachmentPreview);
    if (getQueuedSendGeneration(sessionId) !== generation) return;
    useComposerStateStore.getState().appendHistory(sessionId, draft.text);
    if (goalInvocation && goalInvocation.action !== "set" && goalInvocation.action !== "resume") return;
    useSessionActivityStore.getState().setRunStatus(
      context.workspaceId,
      sessionId,
      { type: "busy" },
    );
    markTaskRunStart(sessionId);
  } catch (error) {
    if (isPromptAdmissionUnknown(error)) {
      dispatchQueuedDrain(sessionId, {
        type: "send_unknown", itemId: nextItem.id, messageID: draft.messageId, at: Date.now(),
      });
      draft.attachments.forEach(revokeAttachmentPreview);
    } else if (getQueuedSendGeneration(sessionId) !== generation) {
      dispatchQueuedDrain(sessionId, { type: "send_result", itemId: nextItem.id, outcome: "cancelled", at: Date.now() });
      draft.attachments.forEach(revokeAttachmentPreview);
    } else {
      dispatchQueuedDrain(sessionId, { type: "send_error", itemId: nextItem.id });
      useComposerStateStore.getState().prependQueuedDrafts(sessionId, [{ id: nextItem.id, draft }]);
    }
  } finally {
    watched.sendInFlight = false;
    if (startRefs > 0) {
      reconcileWatchedSessions();
    }
    if (getComposerQueuedDrafts(useComposerStateStore.getState(), sessionId).length === 0
      && getQueuedDrainState(sessionId).phase.kind !== "admission_unknown") {
      clearQueuedSendContext(sessionId);
    }
  }
}

function stopGlobalQueueDrainer() {
  unsubscribeComposerStore?.();
  unsubscribeContexts?.();
  unsubscribeComposerStore = null;
  unsubscribeContexts = null;
  for (const watched of [...watchedSessions.values()]) {
    releaseWatchedSession(watched, false);
  }
}

export function startGlobalQueueDrainer(): () => void {
  startRefs += 1;
  if (startRefs === 1) {
    unsubscribeComposerStore = useComposerStateStore.subscribe(reconcileWatchedSessions);
    unsubscribeContexts = subscribeQueuedSendContext(reconcileWatchedSessions);
    reconcileWatchedSessions();
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    startRefs = Math.max(0, startRefs - 1);
    if (startRefs === 0) stopGlobalQueueDrainer();
  };
}
