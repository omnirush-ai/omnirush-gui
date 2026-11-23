/** @jsxImportSource react */
// Write approvals (design 1.9): a task that may change things on a site ("Ask me before submitting") pauses before it
// submits; the person sees the screen and the agent's summary, then approves or denies. Paused writes refuse it.
// Also the step screenshot every run view shows (fetched through the local server, shown from a blob: URL).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { OmniRushWorkCloudRun } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";

import { CLOUD_KEY, cloudFailure, cloudRunKey, type CloudClient } from "./cloud-model";

/** The step a `shot_url` points at (`.../runs/<id>/steps/<n>/shot`); null for anything else. */
export function shotStep(url: string | null | undefined): number | null {
  const match = url?.match(/\/steps\/(\d{1,5})\/shot$/);
  return match ? Number(match[1]) : null;
}

/** One step's screenshot, read once (filled sign-in fields are already blurred by the cloud computer). */
export function StepShot(props: { client: CloudClient | null; runId: string; n: number; alt: string; className?: string }) {
  const shot = useQuery({
    queryKey: [CLOUD_KEY, props.client?.baseUrl ?? "default", "shot", props.runId, props.n],
    queryFn: () => props.client!.getWorkCloudStepShot(props.runId, props.n),
    enabled: Boolean(props.client),
    retry: false,
    staleTime: Infinity,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const data = shot.data;
    if (!data || !/^image\/(?:webp|png|jpeg)/i.test(data.contentType ?? "")) { setUrl(null); return; }
    const made = URL.createObjectURL(new Blob([data.data], { type: data.contentType ?? "image/webp" }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [shot.data]);
  if (shot.isLoading) return <Skeleton className={cn("aspect-[16/10] w-full rounded-lg", props.className)} data-testid="work-cloud-shot-loading" />;
  if (!url) return <p className="text-[12px] text-muted-foreground" data-testid="work-cloud-shot-none">{t("work.cloud.shot_none")}</p>;
  return <img src={url} alt={props.alt} className={cn("w-full rounded-lg border border-border bg-muted object-contain", props.className)} data-testid="work-cloud-shot" />;
}

export function Approval(props: { client: CloudClient | null; run: OmniRushWorkCloudRun; writesPaused: boolean }) {
  const queryClient = useQueryClient();
  const n = shotStep(props.run.approval?.shot_url);
  const decide = useMutation({
    mutationFn: (action: "approve" | "deny") => props.client!.workCloudRunAction(props.run.id, action),
    onSuccess: (run, action) => {
      queryClient.setQueryData(cloudRunKey(props.client, props.run.id), run);
      void queryClient.invalidateQueries({ queryKey: [CLOUD_KEY] });
      toast.success(action === "approve" ? t("work.cloud.approved") : t("work.cloud.denied"));
    },
    onError: (reason) => toast.error(cloudFailure(reason).text),
  });
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-amber-6 bg-amber-2 px-4 py-3" aria-label={t("work.cloud.approval_title")} data-testid="work-cloud-approval">
      <div className="flex flex-col gap-1">
        <h3 className="text-[13px] font-semibold text-foreground">{t("work.cloud.approval_title")}</h3>
        <p className="whitespace-pre-wrap text-[13px] text-foreground" data-testid="work-cloud-approval-summary">{props.run.approval?.summary || t("work.cloud.approval_no_summary")}</p>
      </div>
      {n !== null ? <StepShot client={props.client} runId={props.run.id} n={n} alt={t("work.cloud.approval_shot")} className="max-h-[360px]" /> : null}
      {props.writesPaused ? <p className="text-[12px] text-amber-11" data-testid="work-cloud-approval-paused">{t("work.cloud.approval_paused")}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={props.writesPaused || decide.isPending} onClick={() => decide.mutate("approve")} data-testid="work-cloud-approve">{t("work.cloud.approve")}</Button>
        <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate("deny")} data-testid="work-cloud-deny">{t("work.cloud.deny")}</Button>
      </div>
    </section>
  );
}
