/** @jsxImportSource react */
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionGoal, SessionGoalCommand } from "@omnirush/types";
import { OmniRushServerError, type OmniRushServerClient } from "@/app/lib/omnirush-server";
import { formatGoalTime, goalStatusLabel, type GoalInvocation } from "@/app/lib/session-goal";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";

type GoalEditorState = {
  owner: string;
  goalId: string | null;
  objective: string;
  budget: string;
};

type GoalReplacement = { owner: string; command: SessionGoalCommand };
type GoalSelectionSync = { owner: string; goalId: string | null; key: string; desired: string | null; inFlight: boolean };

export function useSessionGoal(options: {
  client: OmniRushServerClient;
  workspaceId: string;
  sessionId: string;
  model: { providerID: string; modelID: string };
  agent: string | null;
  variant: string | null;
  observedAt: number;
}) {
  const queryClient = useQueryClient();
  const owner = JSON.stringify([options.client.baseUrl, options.workspaceId, options.sessionId]);
  const queryKey = ["session-goal", options.client.baseUrl, options.workspaceId, options.sessionId];
  const mutationQueuesRef = useRef(new Map<string, Promise<void>>());
  const cacheRevisionsRef = useRef(new Map<string, number>());
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      await mutationQueuesRef.current.get(owner)?.catch(() => {});
      signal.throwIfAborted();
      return options.client.getSessionGoal(options.workspaceId, options.sessionId, { signal });
    },
    staleTime: 1_000,
    retry: 1,
    refetchInterval: (entry) => {
      const goal = entry.state.data?.goal;
      if (!goal || goal.status === "complete") return false;
      return goal.status === "active" ? 2_000 : 10_000;
    },
  });
  const goal = query.data?.goal ?? null;
  const [editor, setEditor] = useState<GoalEditorState | null>(null);
  const [replacement, setReplacement] = useState<GoalReplacement | null>(null);
  const [pendingOwners, setPendingOwners] = useState<string[]>([]);
  const pendingRef = useRef(new Set<string>());
  const panelRef = useRef<HTMLDivElement>(null);
  const pending = pendingOwners.includes(owner);
  const currentEditor = editor?.owner === owner ? editor : null;
  const currentReplacement = replacement?.owner === owner ? replacement : null;
  const currentOwnerRef = useRef(owner);
  const selectionKey = JSON.stringify([options.model.providerID, options.model.modelID, options.agent, options.variant]);
  const selectionSyncRef = useRef<GoalSelectionSync>({ owner, goalId: null, key: selectionKey, desired: null, inFlight: false });
  const [selectionSyncVersion, setSelectionSyncVersion] = useState(0);

  useEffect(() => {
    currentOwnerRef.current = owner;
    setEditor(null);
    setReplacement(null);
  }, [owner]);

  useEffect(() => {
    if (options.observedAt) void query.refetch();
  }, [options.observedAt, query.refetch]);

  const reportError = useCallback((error: unknown) => {
    if (currentOwnerRef.current !== owner) return;
    toast.error(error instanceof Error ? error.message : "The goal could not be updated.");
  }, [owner]);

  const enqueueMutation = useCallback(async (command: SessionGoalCommand, canSend?: () => boolean) => {
    let sent = false;
    const previous = mutationQueuesRef.current.get(owner) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      if (canSend && !canSend()) return;
      sent = true;
      const revision = (cacheRevisionsRef.current.get(owner) ?? 0) + 1;
      cacheRevisionsRef.current.set(owner, revision);
      await queryClient.cancelQueries({ queryKey: ["session-goal", options.client.baseUrl, options.workspaceId, options.sessionId] });
      const result = await options.client.commandSessionGoal(options.workspaceId, options.sessionId, command);
      if (cacheRevisionsRef.current.get(owner) !== revision) return;
      if (command.goalId) {
        const current = queryClient.getQueryData<{ goal: SessionGoal | null }>(["session-goal", options.client.baseUrl, options.workspaceId, options.sessionId])?.goal;
        if (current?.id !== command.goalId || result.goal?.id !== command.goalId) return;
        if (command.action === "select" && current.status !== "active") return;
      }
      queryClient.setQueryData(["session-goal", options.client.baseUrl, options.workspaceId, options.sessionId], result);
    });
    mutationQueuesRef.current.set(owner, task);
    try {
      await task;
      return sent;
    } finally {
      if (mutationQueuesRef.current.get(owner) === task) mutationQueuesRef.current.delete(owner);
    }
  }, [options.client, options.sessionId, options.workspaceId, owner, queryClient]);

  useEffect(() => {
    let sync = selectionSyncRef.current;
    const goalId = goal?.id ?? null;
    if (sync.owner !== owner || sync.goalId !== goalId) {
      selectionSyncRef.current = { owner, goalId, key: selectionKey, desired: null, inFlight: false };
      return;
    }
    if (goal?.status !== "active") {
      sync.key = selectionKey;
      sync.desired = null;
      return;
    }
    if (sync.key !== selectionKey) {
      sync.key = selectionKey;
      sync.desired = selectionKey;
    }
    if (!sync.desired || sync.inFlight || pendingRef.current.has(owner)) return;
    const targetKey = sync.desired;
    sync.inFlight = true;
    const command: SessionGoalCommand = {
      action: "select", goalId: goal.id,
      model: options.model,
      agent: options.agent ?? "build",
      variant: options.variant ?? "",
    };
    void enqueueMutation(command, () => {
      const current = selectionSyncRef.current;
      const saved = queryClient.getQueryData<{ goal: SessionGoal | null }>(queryKey)?.goal;
      return currentOwnerRef.current === owner && current.owner === owner && current.goalId === command.goalId
        && current.key === targetKey && saved?.id === command.goalId && saved.status === "active"
        && !pendingRef.current.has(owner);
    }).then((sent) => {
      const current = selectionSyncRef.current;
      if (sent && current.owner === owner && current.goalId === command.goalId && current.desired === targetKey) current.desired = null;
    }).catch((error: unknown) => {
      const current = selectionSyncRef.current;
      if (current.owner === owner && current.goalId === command.goalId && current.desired === targetKey) current.desired = null;
      reportError(error);
    }).finally(() => {
      sync = selectionSyncRef.current;
      if (sync.owner !== owner || sync.goalId !== command.goalId) return;
      sync.inFlight = false;
      setSelectionSyncVersion((version) => version + 1);
    });
  }, [enqueueMutation, goal?.id, goal?.status, options.agent, options.model.modelID, options.model.providerID, options.variant, owner, pending, queryClient, reportError, selectionKey, selectionSyncVersion]);

  const readGoal = async () => {
    await mutationQueuesRef.current.get(owner)?.catch(() => {});
    const revision = cacheRevisionsRef.current.get(owner) ?? 0;
    const result = await options.client.getSessionGoal(options.workspaceId, options.sessionId);
    if ((cacheRevisionsRef.current.get(owner) ?? 0) === revision) queryClient.setQueryData(queryKey, result);
    return result.goal;
  };

  const withPending = async (operation: () => Promise<void>) => {
    if (pendingRef.current.has(owner)) return false;
    pendingRef.current.add(owner);
    cacheRevisionsRef.current.set(owner, (cacheRevisionsRef.current.get(owner) ?? 0) + 1);
    setPendingOwners([...pendingRef.current]);
    try {
      await queryClient.cancelQueries({ queryKey });
      await operation();
      return true;
    } catch (error) {
      reportError(error);
      return false;
    } finally {
      pendingRef.current.delete(owner);
      setPendingOwners([...pendingRef.current]);
    }
  };

  const runCommand = async (command: SessionGoalCommand) => {
    await enqueueMutation({
      ...command,
      model: options.model,
      agent: options.agent ?? "build",
      variant: options.variant ?? "",
    });
  };

  const openEditor = (currentGoal: SessionGoal | null) => {
    setEditor({
      owner,
      goalId: currentGoal?.id ?? null,
      objective: currentGoal?.objective ?? "",
      budget: currentGoal?.tokenBudget?.toString() ?? "",
    });
  };

  const requestSet = async (command: SessionGoalCommand) => {
    const currentGoal = await readGoal();
    if (currentOwnerRef.current !== owner) return;
    if (currentGoal && currentGoal.status !== "complete") {
      setReplacement({ owner, command });
    } else {
      await runCommand(command);
      if (currentOwnerRef.current === owner) setEditor(null);
    }
  };

  const handleInvocation = (invocation: GoalInvocation) => withPending(async () => {
    if (invocation.action === "status" || invocation.action === "edit") {
      const currentGoal = await readGoal();
      if (currentOwnerRef.current !== owner) return;
      if (invocation.action === "edit" || !currentGoal) openEditor(currentGoal);
      else panelRef.current?.scrollIntoView({ block: "nearest" });
    } else if (invocation.action === "set") {
      await requestSet({ action: "set", objective: invocation.objective });
    } else {
      await runCommand({ action: invocation.action });
    }
  });

  const saveEditor = async () => {
    if (!currentEditor) return;
    const objective = currentEditor.objective.trim();
    if (!objective || Array.from(objective).length > 4_000) {
      toast.error("Write a goal with 1 to 4,000 characters.");
      return;
    }
    const budgetText = currentEditor.budget.trim();
    const tokenBudget = budgetText ? Number(budgetText) : null;
    if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
      toast.error("Enter a whole token limit greater than zero, or leave it blank.");
      return;
    }
    await withPending(async () => {
      if (!currentEditor.goalId) {
        await requestSet({ action: "set", objective, tokenBudget });
        return;
      }
      const latest = await readGoal();
      if (currentOwnerRef.current !== owner) return;
      if (latest?.id !== currentEditor.goalId) {
        toast.error("This goal changed. Open Edit again.");
        return;
      }
      await runCommand({ action: "edit", goalId: currentEditor.goalId, objective, tokenBudget });
      if (currentOwnerRef.current === owner) setEditor(null);
    });
  };

  const pauseForStop = async () => {
    let currentGoal: SessionGoal | null;
    try {
      currentGoal = await readGoal();
    } catch (error) {
      // Older remote servers can run chats without the goals route.
      if (error instanceof OmniRushServerError && error.status === 404) return;
      throw error;
    }
    if (currentGoal?.status !== "active") return;
    // Persist the pause before the engine interrupt, so idle cannot restart it.
    await enqueueMutation({ action: "pause", goalId: currentGoal.id });
  };

  return {
    handleInvocation,
    pauseForStop,
    ui: (
      <>
        {goal ? (
          <GoalPanel
            goal={goal}
            panelRef={panelRef}
            pending={pending}
            planMode={options.agent === "plan"}
            onAction={(action) => void handleInvocation({ action })}
          />
        ) : null}
        <Dialog open={Boolean(currentEditor)} onOpenChange={(open) => { if (!open) setEditor(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{currentEditor?.goalId ? "Edit goal" : "Set a goal"}</DialogTitle>
              <DialogDescription>
                {currentEditor?.goalId ? "Keep the work and token use counted so far." : "Keep working toward this goal between turns."}
              </DialogDescription>
            </DialogHeader>
            {currentEditor ? (
              <GoalEditor
                value={currentEditor}
                onChange={setEditor}
                pending={pending}
                planMode={options.agent === "plan"}
                onSave={() => void saveEditor()}
                onCancel={() => setEditor(null)}
              />
            ) : null}
          </DialogContent>
        </Dialog>
        <ConfirmModal
          open={Boolean(currentReplacement)}
          title="Replace the current goal?"
          message="This starts a new goal and resets its token use and time. Use Edit to keep the current progress."
          confirmLabel="Replace goal"
          cancelLabel="Cancel"
          onCancel={() => setReplacement(null)}
          onConfirm={() => {
            if (!currentReplacement) return;
            const command = currentReplacement.command;
            setReplacement(null);
            void withPending(async () => {
              await runCommand(command);
              if (currentOwnerRef.current === owner) setEditor(null);
            });
          }}
        />
      </>
    ),
  };
}

function GoalPanel(props: {
  goal: SessionGoal;
  panelRef: RefObject<HTMLDivElement | null>;
  pending: boolean;
  planMode: boolean;
  onAction: (action: "pause" | "resume" | "edit" | "clear") => void;
}) {
  const { goal } = props;
  const limitReached = goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget;
  return (
    <div ref={props.panelRef} data-testid="session-goal" className="mx-3 mb-2 rounded-xl border border-gray-6 bg-gray-2 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-gray-12">Goal</span>
        <span data-testid="goal-status" data-goal-status={goal.status} className="text-gray-10">{goalStatusLabel(goal.status)}</span>
      </div>
      <p data-testid="goal-objective" className="mt-1 whitespace-pre-wrap break-words text-gray-12">{goal.objective}</p>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-gray-10">
        <span data-testid="goal-token-usage">{goal.tokensUsed.toLocaleString()}{goal.tokenBudget !== null ? ` / ${goal.tokenBudget.toLocaleString()}` : ""} tokens</span>
        <span data-testid="goal-time-used">{formatGoalTime(goal.timeUsedSeconds)} active</span>
      </div>
      {props.planMode ? <p className="mt-1 text-gray-10">Goals do not run in Plan mode. Select Build to continue.</p> : null}
      {limitReached ? <p className="mt-1 text-gray-10">Edit the token limit to continue.</p> : null}
      <div className="mt-2 flex gap-3 font-medium text-gray-11">
        {goal.status === "active" ? (
          <button type="button" data-testid="goal-pause" disabled={props.pending} onClick={() => props.onAction("pause")} className="hover:underline disabled:opacity-50">Pause</button>
        ) : goal.status !== "complete" ? (
          <button type="button" data-testid="goal-resume" disabled={props.pending || limitReached || props.planMode} onClick={() => props.onAction("resume")} className="hover:underline disabled:opacity-50">Resume</button>
        ) : null}
        <button type="button" data-testid="goal-edit" disabled={props.pending} onClick={() => props.onAction("edit")} className="hover:underline disabled:opacity-50">Edit</button>
        <button type="button" data-testid="goal-clear" disabled={props.pending} onClick={() => props.onAction("clear")} className="hover:underline disabled:opacity-50">Clear</button>
      </div>
    </div>
  );
}

function GoalEditor(props: {
  value: GoalEditorState;
  onChange: (value: GoalEditorState) => void;
  pending: boolean;
  planMode: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  return (
    <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); props.onSave(); }}>
      <label htmlFor={`${id}-objective`} className="grid gap-2 font-medium">
        Goal
        <textarea
          id={`${id}-objective`}
          data-testid="goal-objective-input"
          rows={4}
          required
          value={props.value.objective}
          onChange={(event) => props.onChange({ ...props.value, objective: event.target.value })}
          className="w-full resize-y rounded-lg border border-gray-6 bg-gray-1 px-3 py-2 font-normal outline-none focus:border-gray-9"
        />
      </label>
      <label htmlFor={`${id}-budget`} className="grid gap-2 font-medium">
        Token limit (optional)
        <input
          id={`${id}-budget`}
          data-testid="goal-budget-input"
          type="number"
          min="1"
          step="1"
          value={props.value.budget}
          onChange={(event) => props.onChange({ ...props.value, budget: event.target.value })}
          className="w-full rounded-lg border border-gray-6 bg-gray-1 px-3 py-2 font-normal outline-none focus:border-gray-9"
        />
        <span className="font-normal text-muted-foreground">Tokens measure AI use. Leave blank for no limit.</span>
      </label>
      {props.planMode ? <p className="text-muted-foreground">The goal will wait in Plan mode. Select Build to run it.</p> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onCancel}>Cancel</Button>
        <Button type="submit" data-testid="goal-save" disabled={props.pending || !props.value.objective.trim()}>{props.pending ? "Saving…" : "Save goal"}</Button>
      </DialogFooter>
    </form>
  );
}
