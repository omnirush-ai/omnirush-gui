/** @jsxImportSource react */
// Work > Meetings, M1: Take notes, the two streams' levels, Pause/Resume and Stop. Shown only while the server
// transcribes meeting audio (capabilities.work.meetings). The meeting list and the live transcript come in M2.
import { Mic, Pause, Play, Square } from "lucide-react";
import { create } from "zustand";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { WorkClient } from "@/react-app/domains/work/work-mode";

import { MeetingRecorder, type MeetingClient, type RecorderState, type StreamState } from "./recorder";

export type MeetingsClient = Pick<WorkClient, "createWorkMeeting" | "updateWorkMeeting" | "uploadWorkMeetingAudio">;

export function meetingClient(client: MeetingsClient): MeetingClient {
  return {
    createMeeting: (body) => client.createWorkMeeting(body),
    endMeeting: (id, endedAt) => client.updateWorkMeeting(id, { ended_at: endedAt }),
    uploadPart: (id, speaker, part, offsetMs, wav) => client.uploadWorkMeetingAudio(id, { speaker, part, offsetMs }, wav),
  };
}

/** The recording outlives the page: leaving Meetings keeps it going. */
export const useMeetingRecorder = create<{ recorder: MeetingRecorder | null; state: RecorderState | null; start: (client: MeetingsClient) => void }>()((set, get) => ({
  recorder: null,
  state: null,
  start: (client) => {
    const busy = get().state?.phase;
    if (busy === "starting" || busy === "recording" || busy === "paused" || busy === "stopping") return;
    const recorder = new MeetingRecorder({ client: meetingClient(client), onChange: (state) => set({ state }) });
    set({ recorder });
    void recorder.start();
  },
}));

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(hours ? 2 : 1, "0");
  return `${hours ? `${hours}:` : ""}${mm}:${String(seconds % 60).padStart(2, "0")}`;
}

function Level(props: { label: string; value: number; state: StreamState; testId: string }) {
  const on = props.state === "on";
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted-foreground" data-testid={props.testId} data-stream={props.state} data-level={props.value.toFixed(2)}>
      <span className="w-10 shrink-0">{props.label}</span>
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-gray-4" role="meter" aria-label={props.label} aria-valuemin={0} aria-valuemax={1} aria-valuenow={props.value}>
        <div className={cn("h-full rounded-full transition-[width] duration-150", on ? "bg-green-9" : "bg-gray-5")} style={{ width: `${Math.round(props.value * 100)}%` }} />
      </div>
    </div>
  );
}

const isMac = () => typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

export function MeetingsPage(props: { client: MeetingsClient | null }) {
  const { recorder, state, start } = useMeetingRecorder();
  const phase = state?.phase ?? "idle";
  const live = phase === "recording" || phase === "paused";
  const lines: Array<{ key: string; text: string }> = [];
  if (state && (live || phase === "done") && state.them === "off") lines.push({ key: "no-system-audio", text: t("work.meetings.no_system_audio") });
  if (live && state?.them === "pending" && isMac()) lines.push({ key: "allow-system-audio", text: t("work.meetings.allow_system_audio") });
  if (state?.catchingUp) lines.push({ key: "catching-up", text: t("work.meetings.catching_up") });
  if (state?.gaps.length) lines.push({ key: "gap", text: t("work.meetings.gap") });
  if (state?.error === "meeting_budget") lines.push({ key: "budget", text: t("work.meetings.budget") });
  else if (phase === "error" || state?.error === "no_audio") lines.push({ key: "error", text: t("work.meetings.failed") });
  if (phase === "done" && !state?.catchingUp) lines.push(state?.backlogMs ? { key: "finishing", text: t("work.meetings.finishing") } : { key: "saved", text: t("work.meetings.saved") });

  return (
    <div className="h-full overflow-y-auto" data-testid="work-meetings">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-10 pt-10">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("work.nav.meetings")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("work.meetings.subtitle")}</p>
        </div>
        {live && state ? (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border px-4 py-3" data-testid="work-meeting-recording" data-phase={phase}>
            <div className="flex items-center gap-4">
              <span className="font-mono text-sm tabular-nums" data-testid="work-meeting-clock">{clock(state.elapsedMs)}</span>
              <div className="flex flex-col gap-1">
                <Level label={t("work.meetings.me")} value={state.levels.me} state={state.me} testId="work-meeting-level-me" />
                <Level label={t("work.meetings.them")} value={state.levels.them} state={state.them} testId="work-meeting-level-them" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              {phase === "paused" ? (
                <Button variant="outline" size="sm" onClick={() => recorder?.resume()} data-testid="work-meeting-resume"><Play className="size-3.5" />{t("work.meetings.resume")}</Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => recorder?.pause()} data-testid="work-meeting-pause"><Pause className="size-3.5" />{t("work.meetings.pause")}</Button>
              )}
              <Button size="sm" onClick={() => void recorder?.stop()} data-testid="work-meeting-stop"><Square className="size-3.5" />{t("work.meetings.stop")}</Button>
            </div>
          </div>
        ) : (
          <div>
            <Button disabled={!props.client || phase === "starting" || phase === "stopping"} onClick={() => props.client && start(props.client)} data-testid="work-meeting-start">
              <Mic className="size-4" />{t("work.meetings.take_notes")}
            </Button>
          </div>
        )}
        {lines.length ? (
          <ul className="flex flex-col gap-1 text-[13px] text-muted-foreground" data-testid="work-meeting-lines">
            {lines.map((line) => <li key={line.key} data-line={line.key}>{line.text}</li>)}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
