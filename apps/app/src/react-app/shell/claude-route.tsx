import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { useBootState } from "./boot-state";
import { claudeSurface, useClaudeEndpoint } from "./claude-offer";

type Session = {
  id: string; createdAt: string; model: string; capture: string; replay: string; issues: string[];
  turns: Array<{number: number; status: string; error?: string}>;
  compatibility?: "current" | "legacy_unverified" | "contract_invalid" | "runtime_upgrade_required";
  contract?: {execution: {os: string; architecture: string}};
  modelIsolation?: {status: "pending" | "observed" | "unknown" | "invalid" | "legacy_unverified"};
  authorization?: {budget: {status: "known" | "unknown"; asOf?: string; remainingTokens?: number | null; sessionRemainingTokens?: number | null; accountRemainingTokens?: number; accountScope?: string} | null};
};
type Event = {type: string; text: string; turn: number};
export function ClaudeRoute() {
  const {workspaceId} = useParams();
  return <WorkspaceClaudeRoute key={workspaceId} workspaceId={workspaceId} />;
}
function WorkspaceClaudeRoute({workspaceId}: {workspaceId: string | undefined}) {
  const {markRouteReady} = useBootState();
  const {endpoint, pending: connecting} = useClaudeEndpoint(workspaceId);
  const [downloadController, setDownloadController] = useState<AbortController | null>(null);
  const [allowed, setAllowed] = useState(false), [ready, setReady] = useState(false), [loaded, setLoaded] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]), [selected, setSelected] = useState<string>();
  const [session, setSession] = useState<Session>(), [events, setEvents] = useState<Event[]>([]);
  const [prompt, setPrompt] = useState(""), [command, setCommand] = useState("");
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const request = useCallback(async <T,>(route: string, body?: unknown): Promise<T> => {
    if (!endpoint) throw new Error("Workspace server is unavailable");
    endpoint.signal.throwIfAborted();
    const result = await endpoint.client.claude.request<T>(endpoint.workspaceId, route, body, endpoint.signal);
    endpoint.signal.throwIfAborted();
    return result;
  }, [endpoint]);
  useEffect(() => {
    if (!connecting) markRouteReady();
  }, [connecting, markRouteReady]);
  const refresh = useCallback(async () => {
    const [status, items] = await Promise.all([
      request<{allowed: boolean; sandboxReady: boolean}>("status"),
      request<Session[]>("sessions"),
    ]);
    setAllowed(status.allowed); setReady(status.sandboxReady);
    setSessions(items); setLoaded(true);
  }, [request]);
  useEffect(() => {
    setLoaded(false); setAllowed(false); setReady(false);
    if (endpoint) void refresh().catch(e => {
      if (!endpoint.signal.aborted) { setError(e.message); setSessions([]); setLoaded(true); }
    });
  }, [endpoint, refresh]);
  useEffect(() => {
    if (!selected) { setSession(undefined); setEvents([]); return; }
    if (!endpoint) return;
    let closed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [next, items] = await Promise.all([request<Session>(`sessions/${selected}`), request<Event[]>(`sessions/${selected}/events`)]);
        if (!closed && !endpoint.signal.aborted) { setSession(next); setEvents(items); }
      } catch (e) { if (!closed && !endpoint.signal.aborted) { setSession(undefined); setEvents([]); setError(e instanceof Error ? e.message : "Session unavailable"); } }
      if (!closed && !endpoint.signal.aborted) timer = setTimeout(poll, 1500);
    };
    void poll(); return () => { closed = true; clearTimeout(timer); };
  }, [selected, request, endpoint]);
  const act = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (e) { if (!endpoint?.signal.aborted) setError(e instanceof Error ? e.message : "Operation failed"); } finally { setBusy(false); } };
  // A persisted unfinished turn does not prove a process is alive. Export
  // asks the server to check ownership of the saved evidence.
  const unfinishedTurn = session?.turns.at(-1)?.status === "running";
  const continuationIssue = session?.modelIsolation?.status === "unknown"
    ? "This session is missing provider model identity evidence. Keep its evidence and start a new session."
    : session?.modelIsolation?.status === "invalid" || session?.compatibility === "contract_invalid"
    ? "This session’s model or environment contract changed. Keep its evidence and start a new session."
    : session?.compatibility === "runtime_upgrade_required"
      ? "This session needs its recorded runtime version. Export its evidence or start a new session."
      : session?.compatibility === "legacy_unverified"
        ? "This older session can be exported. Start a new session to continue with a fixed model."
        : undefined;
  const budget = session?.authorization?.budget;
  const remaining = (tokens: number | null | undefined) => tokens === null ? "no limit" : typeof tokens === "number" ? `${tokens.toLocaleString()} tokens` : "unknown";
  const download = async () => {
    if (!endpoint || !session) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([endpoint.signal, controller.signal]);
    setDownloadController(controller);
    const filename = `claude-${session.id}.zip`;
    try {
    if (isDesktopRuntime()) {
      if (!await endpoint.client.claude.saveExport(endpoint.workspaceId, session.id, signal)) return;
    } else {
      const blob = await endpoint.client.claude.export(endpoint.workspaceId, session.id, signal);
      signal.throwIfAborted();
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    signal.throwIfAborted();
    setNotice("Private session ZIP downloaded.");
    } catch (e) {
      if (!signal.aborted) throw e;
      if (!endpoint.signal.aborted) setNotice("Download cancelled.");
    } finally { setDownloadController(null); }
  };
  const surface = endpoint ? claudeSurface(allowed, sessions.length) : "none";
  if (connecting || endpoint && !loaded) return <main className="mx-auto h-full max-w-5xl p-6" aria-busy="true" />;
  if (surface === "none") {
    return <main className="mx-auto h-full max-w-5xl space-y-4 p-6" data-testid="claude-unavailable">
      <p>This page is not available.</p><Link to={`/workspace/${workspaceId}/session`}>Back to chats</Link>
    </main>;
  }
  return <main className="mx-auto h-full max-w-5xl space-y-4 overflow-auto p-6" aria-label={surface === "full" ? "Claude Code workspace" : "Saved sessions"}>
    <header className="flex items-center justify-between">{surface === "full"
      ? <div><h1 className="text-xl font-semibold">Claude Code</h1><p className="text-sm text-muted-foreground">Opus 5.5 · Private sandbox sessions</p></div>
      : <div><h1 className="text-xl font-semibold">Saved sessions</h1><p className="text-sm text-muted-foreground">Export or recover the sessions saved here.</p></div>}<Link to={`/workspace/${workspaceId}/session`}>Back to chats</Link></header>
    {error && <p role="alert" className="rounded border border-destructive p-3">{error}</p>}
    {notice && <p role="status" data-testid="claude-notice" className="sticky top-0 z-10 rounded border bg-background p-3">{notice}</p>}
    <>
      {allowed && !ready && <p>Start Docker Desktop or Docker Engine, then <button onClick={() => void act(refresh)}>check again</button>.</p>}
      <section className="flex flex-wrap items-center gap-3 rounded border p-3" aria-label="Session controls">
        <select aria-label="Claude session" value={selected ?? ""} onChange={e => { setSession(undefined); setEvents([]); setSelected(e.target.value || undefined); }} className="max-w-64 rounded border bg-background p-2"><option value="">Choose a session</option>{sessions.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.id.slice(0,8)}</option>)}</select>
        {surface === "full" && <><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />Retain private traces and full project snapshots</label>
        <Button disabled={!allowed || !ready || busy || !consent} onClick={() => void act(async () => { setNotice("Preparing the sandbox and copying your project. The first setup may take several minutes."); const created = await request<Session>("sessions", {captureConsent: true}); await refresh(); setSelected(created.id); setNotice("Sandbox ready. Changes stay in this session’s project copy."); })}>New Claude session</Button></>}
      </section>
      {session && <>
        <div className="space-y-1 text-sm" aria-label="Fixed session model">
          <p><strong>{session.model}</strong> · {session.contract ? "Fixed for this session and its subagents" : "Legacy capture; model isolation unverified"}{session.contract && ` · ${session.contract.execution.os} / ${session.contract.execution.architecture}`}</p>
          <p className="text-muted-foreground" aria-label="Model allowance">{budget?.status === "known"
            ? `Allowance at last authorization${budget.asOf ? ` (${new Date(budget.asOf).toLocaleTimeString()})` : ""}: model ${remaining(budget.remainingTokens)} · Session: ${remaining(budget.sessionRemainingTokens)} · Account ${budget.accountScope ?? ""}: ${remaining(budget.accountRemainingTokens)}`
            : "Model allowance has not been reported by the backend."}</p>
          {session.modelIsolation?.status === "unknown" && <p role="status">The provider did not report a model identity for every request. This session needs review.</p>}
          {continuationIssue && <p role="status">{continuationIssue}</p>}
        </div>
        <p className="text-sm" aria-label="Capture status">Capture: {session.capture} · Environment: {session.replay} · {session.turns.length} turns</p>
        {session.issues.length > 0 && <p role="status">Evidence needs recovery: {session.issues.join(", ")}</p>}
        <section aria-label="Claude conversation" className="min-h-52 space-y-3 rounded border p-4">
          {events.length === 0 && <p className="text-muted-foreground">Describe what you want to build or fix.</p>}
          {events.map((event, index) => event.type === "thinking" ? <details key={index}><summary>Reasoning summary</summary><p className="whitespace-pre-wrap">{event.text}</p></details> : <article key={index} className="whitespace-pre-wrap"><strong>{event.type === "user" ? "You" : event.type === "assistant" ? "Claude" : event.type === "tool" ? "Tool" : "Status"}</strong><p>{event.text}</p></article>)}
        </section>
        <form onSubmit={e => { e.preventDefault(); void act(async () => { await request(`sessions/${session.id}/turns`, {prompt}); setPrompt(""); setSession({...session, turns: [...session.turns, {number: session.turns.length + 1, status: "running"}]}); }); }} className="flex gap-2">
          <textarea aria-label="Message Claude" value={prompt} onChange={e => setPrompt(e.target.value)} className="min-h-24 flex-1 rounded border bg-background p-3" placeholder="Describe the development task…" disabled={!endpoint || busy || unfinishedTurn || Boolean(continuationIssue)} />
          <Button type="submit" disabled={!endpoint || busy || unfinishedTurn || Boolean(continuationIssue) || !prompt.trim()}>Send</Button>
          {unfinishedTurn && <Button type="button" variant="outline" disabled={!endpoint || busy} onClick={() => void act(async () => { await request(`sessions/${session.id}/stop`, {}); })}>Stop</Button>}
        </form>
        <section className="flex flex-wrap items-center gap-2" aria-label="Evidence controls">
          <input aria-label="Verification command" value={command} onChange={e => setCommand(e.target.value)} placeholder="Project test command (optional)" className="min-w-64 rounded border bg-background p-2" />
          <Button variant="outline" disabled={!endpoint || busy || unfinishedTurn || !session.turns.length} onClick={() => void act(async () => { await request(`sessions/${session.id}/verify`, command.trim() ? {command} : {}); setNotice("Environment restored and verification passed with network access disabled."); })}>Verify restore</Button>
          <Button variant="outline" disabled={!endpoint || busy || unfinishedTurn} onClick={() => void act(async () => { await request(`sessions/${session.id}/recover`, {}); setNotice("Recovery finished. Check capture status before exporting."); })}>Recover evidence</Button>
          <Button variant="outline" disabled={!endpoint || busy || !session.turns.length} onClick={() => void act(download)}>Download private ZIP</Button>
          {downloadController && <Button variant="outline" onClick={() => downloadController.abort()}>Cancel download</Button>}
          <Button variant="outline" disabled={!endpoint || busy || unfinishedTurn || !session.turns.length} onClick={() => void act(async () => {
            const result = await request<{status: string; native: {status: string}; checkpoint: {status: string}}>(`sessions/${session.id}/upload`, {});
            setNotice(result.native.status === "uploaded" && result.checkpoint.status === "uploaded" ? "Private session uploaded. Backend receipts confirm the native traces and environment arrived."
              : result.native.status === "uploaded" && result.checkpoint.status === "disabled" ? "Native traces uploaded. Environment upload is disabled by the backend; the complete ZIP remains on this device."
              : "Upload is incomplete. Local evidence is retained; retry to resume.");
          })}>Upload private session</Button>
        </section>
        <p className="text-xs text-muted-foreground">The ZIP includes native Claude Code transcripts, available reasoning summaries, tool and subagent activity, and complete environment snapshots. Restore verification checks the saved environment; generated answers may differ on a new run.</p>
      </>}
    </>
  </main>;
}
