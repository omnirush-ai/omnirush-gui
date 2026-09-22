import * as React from "react";
import { Clock3, Loader2, Pencil, Play, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { OmniRushServerClient } from "@/app/lib/omnirush-server";
import type { LocalModelRef, LocalRouteCategory, LocalRouteDecision, LocalRoutingSettings, LocalWorkflow, LocalWorkflowInput, LocalWorkflowRun, LocalWorkflowsSnapshot, LocalWorkflowStep } from "@omnirush/types/local-workflows";
import { ModelSelect } from "./model-select";

type Tab = "routing" | "workflows" | "runs";
const categories: LocalRouteCategory[] = ["general", "coding", "writing", "analysis"];
const tabs: { value: Tab; label: string }[] = [
  { value: "routing", label: "Model routing" },
  { value: "workflows", label: "Workflows" },
  { value: "runs", label: "Run history" },
];
const newStep = (index: number): LocalWorkflowStep => ({ id: `step-${crypto.randomUUID()}`, name: `Step ${index + 1}`, prompt: "", category: "auto", model: null });
const emptyWorkflow = (): LocalWorkflowInput => ({ name: "", description: "", enabled: false, intervalMinutes: null, steps: [newStep(0)] });

function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Something went wrong. Please try again."; }
function formatTime(value: number | null) { return value ? new Date(value).toLocaleString() : "Not yet"; }

export function LocalWorkflowsPanel(props: { open: boolean; onClose: () => void; client: OmniRushServerClient | null | undefined; workspaceId: string; onOpenSession?: (workspaceId: string, sessionId: string) => void }) {
  const [tab, setTab] = React.useState<Tab>("routing");
  const [snapshot, setSnapshot] = React.useState<LocalWorkflowsSnapshot | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [routing, setRouting] = React.useState<LocalRoutingSettings | null>(null);
  const [previewPrompt, setPreviewPrompt] = React.useState("");
  const [preview, setPreview] = React.useState<LocalRouteDecision | null>(null);
  const [draft, setDraft] = React.useState<LocalWorkflowInput | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [selectedRun, setSelectedRun] = React.useState<string | null>(null);
  const [activeAction, setActiveAction] = React.useState<string | null>(null);
  const requestEpoch = React.useRef(0);
  const pendingRead = React.useRef<number | null>(null);

  const reload = React.useCallback(async (options: { resetRouting?: boolean; silent?: boolean } = {}) => {
    if (!props.client || !props.workspaceId) return;
    const epoch = requestEpoch.current;
    if (pendingRead.current === epoch) return;
    pendingRead.current = epoch;
    if (!options.silent) { setLoading(true); setError(null); }
    try {
      const result = await props.client.getLocalWorkflows(props.workspaceId);
      if (requestEpoch.current !== epoch) return;
      setSnapshot((previous) => options.silent && previous ? { ...previous, workflows: result.workflows, runs: result.runs, scheduler: result.scheduler } : result);
      if (options.resetRouting) setRouting(result.routing);
    } catch (e) { if (requestEpoch.current === epoch) setError(errorMessage(e)); }
    finally {
      if (pendingRead.current === epoch) pendingRead.current = null;
      if (requestEpoch.current === epoch && !options.silent) setLoading(false);
    }
  }, [props.client, props.workspaceId]);
  React.useEffect(() => {
    setSnapshot(null); setRouting(null); setDraft(null); setEditingId(null); setPreview(null); setNotice(null); setError(null); setSelectedRun(null);
    if (props.open) void reload({ resetRouting: true });
    return () => { requestEpoch.current += 1; };
  }, [props.open, reload]);
  const shouldPoll = Boolean(snapshot?.runs.some((run) => run.status === "running") || snapshot?.workflows.some((workflow) => workflow.enabled && workflow.intervalMinutes !== null));
  React.useEffect(() => {
    if (!props.open || !props.client || !shouldPoll) return;
    const timer = window.setInterval(() => void reload({ silent: true }), 2000);
    return () => window.clearInterval(timer);
  }, [props.open, props.client, shouldPoll, reload]);

  const models = snapshot?.models ?? [];
  const updateRouting = (category: LocalRouteCategory, model: LocalModelRef | null) => setRouting((previous) => previous ? { ...previous, categories: { ...previous.categories, [category]: model ?? undefined } } : previous);
  const saveRouting = async () => {
    if (!props.client || !routing) return;
    setSaving(true); setError(null); setNotice(null);
    try { const saved = await props.client.saveLocalWorkflowRouting(props.workspaceId, routing); setRouting(saved); setSnapshot((previous) => previous ? { ...previous, routing: saved } : previous); setPreview(null); setNotice("Routing settings saved."); }
    catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  };
  const routePreview = async () => {
    if (!props.client || !previewPrompt.trim()) return;
    setSaving(true); setError(null); setPreview(null);
    try { setPreview(await props.client.previewLocalWorkflowRoute(props.workspaceId, { prompt: previewPrompt.trim(), category: "auto" })); }
    catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  };
  const saveWorkflow = async () => {
    if (!props.client || !draft || !draft.name.trim() || draft.steps.some((step) => !step.prompt.trim() || !step.name.trim())) { setError("Add a name and a prompt for every step."); return; }
    if (draft.intervalMinutes !== null && (!Number.isInteger(draft.intervalMinutes) || draft.intervalMinutes < 1 || draft.intervalMinutes > 43200)) { setError("Use a whole-number interval from 1 to 43,200 minutes, or leave it blank for manual runs."); return; }
    setSaving(true); setError(null); setNotice(null);
    try {
      const input = { ...draft, name: draft.name.trim(), description: draft.description.trim(), steps: draft.steps.map((step) => ({ ...step, name: step.name.trim(), prompt: step.prompt.trim() })) };
      const result = editingId ? await props.client.updateLocalWorkflow(props.workspaceId, editingId, input) : await props.client.createLocalWorkflow(props.workspaceId, input);
      setSnapshot((previous) => previous ? { ...previous, workflows: editingId ? previous.workflows.map((item) => item.id === result.id ? result : item) : [...previous.workflows, result] } : previous);
      setDraft(null); setEditingId(null); setNotice("Workflow saved."); setTab("workflows");
    } catch (e) { setError(errorMessage(e)); } finally { setSaving(false); }
  };
  const toggleWorkflow = async (workflow: LocalWorkflow) => {
    if (!props.client || workflow.intervalMinutes === null) return; setError(null); setActiveAction(workflow.id);
    try { const result = await props.client.updateLocalWorkflow(props.workspaceId, workflow.id, { enabled: !workflow.enabled }); setSnapshot((previous) => previous ? { ...previous, workflows: previous.workflows.map((item) => item.id === result.id ? result : item) } : previous); }
    catch (e) { setError(errorMessage(e)); } finally { setActiveAction(null); }
  };
  const deleteWorkflow = async (workflow: LocalWorkflow) => {
    if (!props.client) return; setError(null); setActiveAction(workflow.id);
    try { await props.client.deleteLocalWorkflow(props.workspaceId, workflow.id); setSnapshot((previous) => previous ? { ...previous, workflows: previous.workflows.filter((item) => item.id !== workflow.id) } : previous); setNotice("Workflow deleted."); }
    catch (e) { setError(errorMessage(e)); } finally { setActiveAction(null); }
  };
  const runWorkflow = async (workflow: LocalWorkflow) => {
    if (!props.client) return; setError(null); setNotice(null); setActiveAction(workflow.id);
    try { const run = await props.client.runLocalWorkflow(props.workspaceId, workflow.id); setSnapshot((previous) => previous ? { ...previous, runs: [run, ...previous.runs.filter((item) => item.id !== run.id)] } : previous); setTab("runs"); setSelectedRun(run.id); setNotice("Workflow run started."); }
    catch (e) { setError(errorMessage(e)); } finally { setActiveAction(null); }
  };
  const cancelRun = async (run: LocalWorkflowRun) => {
    if (!props.client) return; setError(null); setActiveAction(run.id);
    try { const result = await props.client.cancelLocalWorkflowRun(props.workspaceId, run.id); setSnapshot((previous) => previous ? { ...previous, runs: previous.runs.map((item) => item.id === result.id ? result : item) } : previous); } catch (e) { setError(errorMessage(e)); } finally { setActiveAction(null); }
  };

  return <Dialog open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <DialogContent data-testid="local-workflows-panel" className="max-h-[min(90dvh,760px)] w-[calc(100%-2rem)] overflow-y-auto lg:max-w-4xl">
      <DialogHeader><DialogTitle className="flex items-center gap-2"><Clock3 className="size-5" />Workflows &amp; model routing</DialogTitle><DialogDescription>Local orchestration for this workspace. Routing applies when workflows run; chat model selection stays explicit.</DialogDescription></DialogHeader>
      {!props.client ? <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">Connect this workspace to omnirush.ai Server to manage workflows.</div> : null}
      {error ? <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div> : null}
      {notice ? <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">{notice}</div> : null}
      <div className="flex gap-1 rounded-xl bg-muted p-1" role="tablist" aria-label="Workflow tools">{tabs.map(({ value, label }) => <button key={value} type="button" role="tab" id={`local-workflows-tab-${value}`} aria-controls={`local-workflows-content-${value}`} aria-selected={tab === value} className={cn("flex-1 rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", tab === value && "bg-background shadow-sm")} onClick={() => setTab(value)}>{label}</button>)}</div>
      {loading ? <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading workspace configuration…</div> : null}
      {!loading && tab === "routing" ? <RoutingTab routing={routing} models={models} prompt={previewPrompt} setPrompt={setPreviewPrompt} preview={preview} saving={saving} onToggle={(enabled) => setRouting((value) => value ? { ...value, enabled } : value)} onDefault={(model) => setRouting((value) => value ? { ...value, defaultModel: model } : value)} onCategory={updateRouting} onSave={() => void saveRouting()} onPreview={() => void routePreview()} modelsError={snapshot?.modelsError ?? null} /> : null}
      {!loading && tab === "workflows" ? <WorkflowsTab
        workflows={snapshot?.workflows ?? []}
        models={models}
        draft={draft}
        setDraft={setDraft}
        editing={editingId !== null}
        saving={saving}
        activeAction={activeAction}
        runningWorkflowIds={snapshot?.runs.filter((run) => run.status === "running").map((run) => run.workflowId) ?? []}
        ready={Boolean(snapshot && props.client)}
        onNew={() => { setEditingId(null); setDraft(emptyWorkflow()); }}
        onEdit={(workflow) => { setEditingId(workflow.id); setDraft({ name: workflow.name, description: workflow.description, enabled: workflow.enabled, intervalMinutes: workflow.intervalMinutes, steps: workflow.steps }); }}
        onTemplate={() => {
          setEditingId(null);
          setDraft({ ...emptyWorkflow(), name: "Research and polish", description: "A two-step brief using the previous output. Edit the topic before running.", steps: [
            { ...newStep(0), name: "Draft", category: "writing", prompt: "Draft a concise internal announcement about a new local workflow automation feature. Explain the user benefit and that scheduled runs need the desktop app open. Use only the information in this prompt; do not read or modify files." },
            { ...newStep(1), name: "Polish", category: "writing", prompt: "Polish the previous step output into a clear announcement with a title, three short benefits, and one limitation. Do not read or modify files." },
          ] });
        }}
        onSave={() => void saveWorkflow()}
        onToggle={(workflow) => void toggleWorkflow(workflow)}
        onDelete={(workflow) => void deleteWorkflow(workflow)}
        onRun={(workflow) => void runWorkflow(workflow)}
      /> : null}
      {!loading && tab === "runs" ? <RunsTab runs={snapshot?.runs ?? []} selectedRun={selectedRun} setSelectedRun={setSelectedRun} activeAction={activeAction} onCancel={(run) => void cancelRun(run)} onOpenSession={props.onOpenSession ? (sessionId) => { props.onOpenSession?.(props.workspaceId, sessionId); props.onClose(); } : undefined} /> : null}
      {snapshot?.scheduler ? <p className="text-xs text-muted-foreground">Scheduler: {snapshot.scheduler.active ? snapshot.scheduler.description : "Not active in this desktop build. Manual runs are always available."}</p> : null}
      <DialogFooter><Button variant="outline" onClick={() => void reload()} disabled={loading}><RefreshCw className="size-4" />Refresh</Button><Button variant="outline" onClick={props.onClose}><X className="size-4" />Close</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function RoutingTab(props: { routing: LocalRoutingSettings | null; models: LocalWorkflowsSnapshot["models"]; prompt: string; setPrompt: (value: string) => void; preview: LocalRouteDecision | null; saving: boolean; onToggle: (value: boolean) => void; onDefault: (value: LocalModelRef | null) => void; onCategory: (category: LocalRouteCategory, value: LocalModelRef | null) => void; onSave: () => void; onPreview: () => void; modelsError: string | null }) {
  if (!props.routing) return <div className="py-8 text-sm text-muted-foreground">Routing settings are unavailable.</div>;
  const routing = props.routing;
  return <div role="tabpanel" id="local-workflows-content-routing" aria-labelledby="local-workflows-tab-routing" className="grid gap-5"><div className="flex items-start justify-between rounded-xl border p-4"><div><p className="font-medium">Workflow model routing</p><p className="text-xs text-muted-foreground">Enable category rules for workflow steps. Otherwise, steps use the default model. Explicit step overrides always take priority.</p></div><input aria-label="Enable workflow model routing" type="checkbox" checked={routing.enabled} onChange={(event) => props.onToggle(event.target.checked)} className="mt-1 size-4" /></div>
    {props.modelsError ? <p className="text-sm text-warning">Connected models could not be loaded: {props.modelsError}</p> : null}{props.models.length === 0 ? <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No connected models are available. Add a provider before selecting routing targets.</p> : null}
    <div className="grid gap-3 sm:grid-cols-2"><ModelSelect label="Default model" testId="routing-default-model" models={props.models} value={routing.defaultModel} onChange={props.onDefault} emptyLabel="Select a connected model" />{categories.map((category) => <ModelSelect key={category} label={`${category[0].toUpperCase()}${category.slice(1)} category`} testId={`routing-category-${category}`} models={props.models} value={routing.categories[category] ?? null} onChange={(value) => props.onCategory(category, value)} emptyLabel="Use default model" disabled={!routing.enabled} />)}</div>
    <div className="rounded-xl border p-4"><p className="font-medium">Prompt preview</p><p className="mb-3 text-xs text-muted-foreground">Uses your saved routing settings without making an LLM call. Save any changes above before previewing.</p><div className="flex gap-2"><Input aria-label="Prompt to preview" data-testid="routing-preview-prompt" value={props.prompt} onChange={(event) => props.setPrompt(event.target.value)} placeholder="e.g. Summarize the latest project risks" /><Button data-testid="routing-preview-submit" onClick={props.onPreview} disabled={props.saving || !props.prompt.trim()}>Preview</Button></div>{props.preview ? <div data-testid="routing-preview-result" className="mt-3 rounded-lg bg-muted p-3 text-sm"><p className="break-words font-medium">{props.preview.model.providerID} / {props.preview.model.modelID}</p><p className="text-xs text-muted-foreground">{props.preview.category} · {props.preview.source} · {props.preview.reason}</p></div> : null}</div>
    <Button data-testid="routing-save" onClick={props.onSave} disabled={props.saving}><Save className="size-4" />Save routing</Button>
  </div>;
}

function WorkflowsTab(props: {
  workflows: LocalWorkflow[];
  models: LocalWorkflowsSnapshot["models"];
  draft: LocalWorkflowInput | null;
  setDraft: (draft: LocalWorkflowInput | null) => void;
  editing: boolean;
  saving: boolean;
  activeAction: string | null;
  runningWorkflowIds: string[];
  ready: boolean;
  onNew: () => void;
  onEdit: (workflow: LocalWorkflow) => void;
  onTemplate: () => void;
  onSave: () => void;
  onToggle: (workflow: LocalWorkflow) => void;
  onDelete: (workflow: LocalWorkflow) => void;
  onRun: (workflow: LocalWorkflow) => void;
}) {
  const draft = props.draft;
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const updateStep = (index: number, patch: Partial<LocalWorkflowInput["steps"][number]>) => { if (!draft) return; props.setDraft({ ...draft, steps: draft.steps.map((step, position) => position === index ? { ...step, ...patch } : step) }); };
  return <div role="tabpanel" id="local-workflows-content-workflows" aria-labelledby="local-workflows-tab-workflows" className="grid gap-4">
    <div className="flex flex-wrap gap-2">
      <Button data-testid="workflow-new" variant="outline" onClick={props.onNew} disabled={!props.ready || draft !== null}><Plus className="size-4" />New workflow</Button>
      <Button data-testid="workflow-add-template" variant="outline" onClick={props.onTemplate} disabled={!props.ready || draft !== null}>Add example template</Button>
    </div>
    {draft ? <div className="grid gap-4 rounded-xl border p-4">
      <h3 className="font-medium">{props.editing ? "Edit workflow" : "New workflow"}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">Workflow name</span>
          <Input data-testid="workflow-name" maxLength={120} value={draft.name} onChange={(event) => props.setDraft({ ...draft, name: event.target.value })} placeholder="Weekly project brief" />
        </label>
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">Interval (minutes)</span>
          <Input data-testid="workflow-interval" type="number" min={1} max={43200} step={1} placeholder="Manual only" value={draft.intervalMinutes ?? ""} onChange={(event) => props.setDraft({ ...draft, enabled: event.target.value ? draft.enabled : false, intervalMinutes: event.target.value ? Number(event.target.value) : null })} />
        </label>
      </div>
      <label className="grid gap-1.5 text-sm">
        <span className="font-medium">Description</span>
        <Textarea maxLength={2000} value={draft.description} onChange={(event) => props.setDraft({ ...draft, description: event.target.value })} placeholder="What this workflow produces" />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input data-testid="workflow-schedule-enabled" type="checkbox" checked={draft.enabled} disabled={draft.intervalMinutes === null} onChange={(event) => props.setDraft({ ...draft, enabled: event.target.checked })} className="size-4" />
        <span>Enable interval schedule (the app must be open)</span>
      </label>
      <p className="text-xs text-muted-foreground">Steps run in order. Each step receives the previous output automatically. They use the workspace's tools and permissions and may incur provider usage.</p>
      <div className="grid gap-3">{draft.steps.map((step, index) => <div key={step.id} className="grid gap-3 rounded-lg bg-muted/50 p-3">
        <div className="flex items-end gap-2">
          <label className="grid flex-1 gap-1.5 text-sm"><span className="font-medium">Step {index + 1} name</span><Input data-testid={`workflow-step-name-${index}`} aria-label={`Step ${index + 1} name`} maxLength={120} value={step.name} onChange={(event) => updateStep(index, { name: event.target.value })} placeholder="Step name" /></label>
          {draft.steps.length > 1 ? <Button variant="ghost" size="icon-sm" aria-label={`Remove step ${index + 1}`} onClick={() => props.setDraft({ ...draft, steps: draft.steps.filter((_, position) => position !== index) })}><Trash2 className="size-4" /></Button> : null}
        </div>
        <label className="grid gap-1.5 text-sm"><span className="font-medium">Prompt</span><Textarea data-testid={`workflow-step-prompt-${index}`} aria-label={`Step ${index + 1} prompt`} maxLength={16000} value={step.prompt} onChange={(event) => updateStep(index, { prompt: event.target.value })} placeholder={index === 0 ? "Instructions for this step" : "Instructions using the previous step's output"} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5 text-sm">
            <span className="font-medium">Task category</span>
            <Select value={step.category} onValueChange={(value) => {
              if (value === "auto") updateStep(index, { category: value });
              else { const category = categories.find((item) => item === value); if (category) updateStep(index, { category }); }
            }}>
              <SelectTrigger aria-label={`Step ${index + 1} category`} data-testid={`workflow-step-category-${index}`} className="w-full rounded-xl"><SelectValue>{step.category === "auto" ? "Auto (classify prompt)" : step.category}</SelectValue></SelectTrigger>
              <SelectContent align="start">
                <SelectItem value="auto" data-testid={`workflow-step-category-${index}-option-auto`}>Auto (classify prompt)</SelectItem>
                {categories.map((category) => <SelectItem key={category} value={category} data-testid={`workflow-step-category-${index}-option-${category}`}>{category}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <ModelSelect label={`Step ${index + 1} model override`} testId={`workflow-step-model-${index}`} models={props.models} value={step.model} onChange={(value) => updateStep(index, { model: value })} emptyLabel="Auto (use routing)" />
        </div>
      </div>)}</div>
      <div className="flex flex-wrap gap-2">
        <Button data-testid="workflow-add-step" variant="outline" disabled={draft.steps.length >= 8} onClick={() => props.setDraft({ ...draft, steps: [...draft.steps, newStep(draft.steps.length)] })}><Plus className="size-4" />Add step</Button>
        <Button data-testid="workflow-save" onClick={props.onSave} disabled={props.saving}><Save className="size-4" />{props.saving ? "Saving…" : "Save workflow"}</Button>
        <Button variant="ghost" onClick={() => props.setDraft(null)} disabled={props.saving}>Cancel</Button>
      </div>
      {draft.steps.length === 8 ? <p className="text-xs text-muted-foreground">Maximum of 8 steps per workflow.</p> : null}
    </div> : null}
    {props.workflows.length === 0 && !draft ? <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No workflows yet. Create one or add the example template; nothing runs automatically.</div> : null}
    <div className="grid gap-2">{props.workflows.map((workflow) => <div key={workflow.id} data-testid={`workflow-card-${workflow.id}`} className="rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="break-words font-medium">{workflow.name}</p><p className="text-xs text-muted-foreground">{workflow.description ? `${workflow.description} · ` : ""}{workflow.steps.length} sequential steps</p></div>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs", workflow.enabled ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground")}>{workflow.intervalMinutes === null ? "Manual only" : workflow.enabled ? `Every ${workflow.intervalMinutes}m` : "Paused"}</span>
      </div>
      {workflow.enabled && workflow.nextRunAt ? <p className="mt-2 text-xs text-muted-foreground">Next run: {formatTime(workflow.nextRunAt)}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button data-testid={`workflow-run-${workflow.id}`} size="sm" disabled={props.activeAction !== null || props.runningWorkflowIds.length > 0} onClick={() => props.onRun(workflow)}><Play className="size-3.5" />{props.runningWorkflowIds.includes(workflow.id) ? "Running…" : "Run now"}</Button>
        <Button data-testid={`workflow-edit-${workflow.id}`} size="sm" variant="outline" disabled={props.activeAction !== null || draft !== null} onClick={() => props.onEdit(workflow)}><Pencil className="size-3.5" />Edit</Button>
        <Button data-testid={`workflow-toggle-${workflow.id}`} size="sm" variant="outline" disabled={workflow.intervalMinutes === null || props.activeAction !== null} title={workflow.intervalMinutes === null ? "Edit this workflow to set an interval first" : undefined} onClick={() => props.onToggle(workflow)}>{workflow.intervalMinutes === null ? "Manual only" : workflow.enabled ? "Pause schedule" : "Enable schedule"}</Button>
        <Button data-testid={`workflow-delete-${workflow.id}`} size="sm" variant="ghost" disabled={props.activeAction !== null || props.runningWorkflowIds.includes(workflow.id)} onClick={() => setDeleteId(workflow.id)}><Trash2 className="size-3.5" />Delete</Button>
      </div>
      {deleteId === workflow.id ? <div className="mt-3 rounded-lg border border-destructive/30 p-3 text-sm">
        <p>Delete “{workflow.name}”? The workflow cannot be restored; run history will remain.</p>
        <div className="mt-2 flex gap-2"><Button data-testid={`workflow-delete-confirm-${workflow.id}`} size="sm" variant="destructive" onClick={() => { props.onDelete(workflow); setDeleteId(null); }}>Delete workflow</Button><Button size="sm" variant="outline" onClick={() => setDeleteId(null)}>Keep workflow</Button></div>
      </div> : null}
    </div>)}</div>
  </div>;
}

function RunsTab(props: { runs: LocalWorkflowRun[]; selectedRun: string | null; setSelectedRun: (value: string | null) => void; activeAction: string | null; onCancel: (run: LocalWorkflowRun) => void; onOpenSession?: (sessionId: string) => void }) {
  const runs = [...props.runs].sort((a, b) => b.startedAt - a.startedAt); const selected = runs.find((run) => run.id === props.selectedRun) ?? null;
  return <div role="tabpanel" id="local-workflows-content-runs" aria-labelledby="local-workflows-tab-runs" className="grid gap-3">
    <p className="text-xs text-muted-foreground">Recent runs are saved locally. Open a run to inspect routing decisions, step output, and its original sessions.</p>
    {runs.length === 0 ? <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No runs yet. Start a workflow to see each step, model decision, output, and errors here.</div> : null}
    {runs.map((run) => <button type="button" key={run.id} data-testid={`workflow-run-detail-${run.id}`} aria-expanded={selected?.id === run.id} className={cn("rounded-xl border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected?.id === run.id && "border-foreground")} onClick={() => props.setSelectedRun(run.id)}>
      <div className="flex items-center justify-between gap-3"><span className="break-words font-medium">{run.workflowName}</span><span data-testid={`workflow-run-status-${run.id}`} className={cn("shrink-0 text-xs capitalize", run.status === "failed" && "text-destructive", run.status === "completed" && "text-emerald-700 dark:text-emerald-300")}>{run.status}</span></div>
      <p className="mt-1 text-xs text-muted-foreground">{formatTime(run.startedAt)} · {run.trigger} · {run.steps.filter((step) => step.status === "completed").length}/{run.steps.length} steps completed</p>
    </button>)}
    {selected ? <div className="rounded-xl border bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-3"><h3 className="break-words font-medium">{selected.workflowName} details</h3>{selected.status === "running" ? <Button data-testid={`workflow-run-cancel-${selected.id}`} size="sm" variant="outline" disabled={props.activeAction !== null} onClick={() => props.onCancel(selected)}>Cancel run</Button> : null}</div>
      {selected.finishedAt ? <p className="mt-1 text-xs text-muted-foreground">Finished {formatTime(selected.finishedAt)}</p> : null}
      <div className="mt-3 grid gap-2">{selected.steps.map((step) => <div key={step.stepId} data-testid={`workflow-run-step-${step.stepId}`} className="rounded-lg border bg-background p-3 text-sm">
        <div className="flex justify-between gap-3"><span className="font-medium">{step.name}</span><span className="capitalize text-muted-foreground">{step.status}</span></div>
        {step.decision ? <p className="mt-1 break-words text-xs text-muted-foreground">Model: {step.decision.model.providerID} / {step.decision.model.modelID} · {step.decision.source}<br />{step.decision.reason}</p> : null}
        {step.output ? <details className="mt-2"><summary className="cursor-pointer text-xs">Show output</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">{step.output}</pre></details> : null}
        {step.error ? <p className="mt-2 whitespace-pre-wrap text-xs text-destructive">{step.error}</p> : null}
        {step.sessionId && props.onOpenSession ? <Button data-testid={`workflow-run-session-${step.stepId}`} variant="link" size="sm" className="mt-2 h-auto p-0" onClick={() => { const sessionId = step.sessionId; if (sessionId) props.onOpenSession?.(sessionId); }}>Open session</Button> : null}
      </div>)}</div>
      {selected.error ? <p className="mt-3 whitespace-pre-wrap text-sm text-destructive">{selected.error}</p> : null}
    </div> : null}
  </div>;
}
