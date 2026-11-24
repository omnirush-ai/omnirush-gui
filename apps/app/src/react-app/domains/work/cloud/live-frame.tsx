/** @jsxImportSource react */
// The live view (design 3.4, judge M8, M21): the cloud computer's screen in a 16:10 frame with one bar under it. The
// page is the worker's noVNC viewer on the account's own server, opened with a short single-use ticket carried in the
// URL fragment; the frame is sandboxed, sends no referrer and gets no browser features. While the agent works the view
// takes no input (the server drops it too); Take over pauses the agent and swaps in a control ticket, Hand back gives
// it back with an optional note. Only the task's owner and the company's owner or admins may take over.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MonitorPlay } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { OmniRushWorkCloudRun } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import { CLOUD_KEY, cloudFailure, cloudRunKey, liveUrlOk, WAIT_TEXT, waitingText, type CloudClient } from "./cloud-model";

/** A live session ends after 10 minutes; a fresh ticket comes a little before. */
const TICKET_REFRESH_MS = 9 * 60_000;

export function LiveFrame(props: { client: CloudClient | null; run: OmniRushWorkCloudRun; canControl: boolean }) {
  const queryClient = useQueryClient();
  const noteId = useId();
  const control = props.run.status === "waiting" && props.run.waiting_for === "takeover";
  const mode = control ? "control" : "view";
  const takeRef = useRef<HTMLButtonElement>(null);
  const handRef = useRef<HTMLButtonElement>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  // A ticket is good for one connection: each mode change asks for a new one, and none is kept after the frame goes.
  const ticket = useQuery({
    queryKey: [CLOUD_KEY, props.client?.baseUrl ?? "default", "live", props.run.id, mode],
    queryFn: () => props.client!.openWorkCloudLive(props.run.id, mode),
    enabled: Boolean(props.client),
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchInterval: TICKET_REFRESH_MS,
  });
  const url = ticket.data && liveUrlOk(ticket.data.url) ? ticket.data.url : null;
  const failed = ticket.isError || (ticket.data && !url);
  const changed = (run: OmniRushWorkCloudRun) => {
    queryClient.setQueryData(cloudRunKey(props.client, props.run.id), run);
    void queryClient.invalidateQueries({ queryKey: [CLOUD_KEY, props.client?.baseUrl ?? "default", "tasks"] });
  };
  const take = useMutation({
    mutationFn: () => props.client!.workCloudRunAction(props.run.id, "takeover"),
    onSuccess: changed,
    onError: (reason) => toast.error(cloudFailure(reason).text),
  });
  const hand = useMutation({
    mutationFn: () => props.client!.handBackWorkCloudRun(props.run.id, note.trim() || undefined),
    onSuccess: (run) => { setNote(""); setNoteOpen(false); changed(run); },
    onError: (reason) => toast.error(cloudFailure(reason).text),
  });
  // Keyboard: after Take over the cursor lands on Hand back, and back on Take over after Hand back.
  const wasControl = useRef(control);
  useEffect(() => {
    if (wasControl.current !== control) (control ? handRef : takeRef).current?.focus();
    wasControl.current = control;
  }, [control]);
  const waitingOnPerson = props.run.status === "waiting" && props.run.waiting_for && props.run.waiting_for !== "takeover";
  const line = control ? t("work.cloud.live_control") : waitingOnPerson ? waitingText(props.run.waiting_for) : t("work.cloud.live_working");
  return (
    // shrink-0: inside the run view's scrolling column the frame keeps its 16:10 screen and its bar (Take over, Hand
    // back) instead of being squeezed under the blocks after it.
    <section className="shrink-0 overflow-hidden rounded-xl border border-border bg-background" aria-label={t("work.cloud.live_title")} data-testid="work-cloud-live" data-mode={mode}>
      <div className="relative aspect-[16/10] w-full bg-muted">
        {url ? (
          <iframe
            key={url}
            src={url}
            title={t("work.cloud.live_title")}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            allow=""
            tabIndex={control ? 0 : -1}
            className="absolute inset-0 size-full border-0"
            data-testid="work-cloud-live-frame"
          />
        ) : failed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center" data-testid="work-cloud-live-error">
            <MonitorPlay aria-hidden className="size-5 text-muted-foreground" />
            <p className="text-[13px] text-muted-foreground">{ticket.error ? cloudFailure(ticket.error).text : t("work.cloud.fail_live_unavailable")}</p>
            <Button size="sm" variant="outline" onClick={() => void ticket.refetch()}>{t("work.common.try_again")}</Button>
          </div>
        ) : (
          <Skeleton className="absolute inset-0 rounded-none" data-testid="work-cloud-live-loading" />
        )}
        {/* While the agent works, the frame takes no clicks or keys (the server drops them as well). */}
        {url && !control ? <div aria-hidden className="absolute inset-0 cursor-default" data-testid="work-cloud-live-shield" /> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-3 py-2">
        <span className={cn("flex min-w-0 flex-1 items-center gap-2 text-[13px]", control || waitingOnPerson ? WAIT_TEXT : "text-foreground")} aria-live="polite" data-testid="work-cloud-live-line">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", control || waitingOnPerson ? "bg-amber-9" : "bg-blue-9 motion-safe:animate-pulse")} />
          <span className="min-w-0">{line}</span>
        </span>
        {control ? (
          <div className="flex flex-wrap items-center gap-2">
            {noteOpen ? (
              <>
                <label htmlFor={noteId} className="sr-only">{t("work.cloud.note_label")}</label>
                <Input id={noteId} value={note} maxLength={500} autoFocus placeholder={t("work.cloud.note_placeholder")} onChange={(event) => setNote(event.target.value)} className="h-8 w-56 text-[13px]" data-testid="work-cloud-note" />
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setNoteOpen(true)} data-testid="work-cloud-note-open">{t("work.cloud.note_open")}</Button>
            )}
            <Button ref={handRef} size="sm" disabled={hand.isPending} onClick={() => hand.mutate()} data-testid="work-cloud-handback">{t("work.cloud.hand_back")}</Button>
          </div>
        ) : props.canControl ? (
          <Button ref={takeRef} size="sm" variant={props.run.waiting_for === "signin" || props.run.waiting_for === "captcha" || props.run.waiting_for === "decision" ? "default" : "outline"} disabled={take.isPending || Boolean(failed)} onClick={() => take.mutate()} data-testid="work-cloud-takeover">{t("work.cloud.take_over")}</Button>
        ) : null}
      </div>
    </section>
  );
}
