/** @jsxImportSource react */
// "Enter code" (design 1.7, judge M6): a run waits on a sign-in code from the site. The person types it here, the server
// types it into the site's code field for the agent; it is never kept, logged or shown to the model, and the field
// empties as soon as it is sent.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import type { OmniRushWorkCloudRun } from "@/app/lib/omnirush-server";

import { cloudFailure, cloudRunKey, type CloudClient } from "./cloud-model";

/** A code as sent: what the field holds without spaces; null until it could be one (3 to 12 letters or digits). */
export function codeValue(value: string): string | null {
  const code = value.replace(/\s+/g, "");
  return /^[A-Za-z0-9-]{3,12}$/.test(code) ? code : null;
}

export function CodeEntry(props: { client: CloudClient | null; run: OmniRushWorkCloudRun; site: string; autoFocus?: boolean }) {
  const queryClient = useQueryClient();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (code: string) => props.client!.sendWorkCloudCode(props.run.id, code),
    onSuccess: (run) => queryClient.setQueryData(cloudRunKey(props.client, props.run.id), run),
    onError: (reason) => { setError(cloudFailure(reason).text); input.current?.focus(); },
  });
  const code = codeValue(value);
  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-amber-6 bg-amber-2 px-4 py-3"
      data-testid="work-cloud-code"
      onSubmit={(event) => {
        event.preventDefault();
        if (!code || send.isPending) return;
        setError(null);
        setValue("");
        send.mutate(code);
      }}
    >
      <label htmlFor={id} className="text-[13px] font-medium text-foreground">{t("work.cloud.code_from", { site: props.site })}</label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={input}
          id={id}
          value={value}
          onChange={(event) => { setValue(event.target.value); setError(null); }}
          inputMode="numeric"
          autoComplete="one-time-code"
          spellCheck={false}
          maxLength={16}
          autoFocus={props.autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          className="h-9 w-40 font-mono tracking-[0.2em] tabular-nums"
          data-testid="work-cloud-code-input"
        />
        <Button type="submit" size="sm" disabled={!code || send.isPending} data-testid="work-cloud-code-send">{send.isPending ? t("work.cloud.sending") : t("work.cloud.send")}</Button>
      </div>
      {error ? <p role="alert" className="text-[12px] text-red-11">{error}</p> : null}
      <p id={`${id}-hint`} className="text-[12px] text-muted-foreground">{t("work.cloud.code_hint")}</p>
    </form>
  );
}
