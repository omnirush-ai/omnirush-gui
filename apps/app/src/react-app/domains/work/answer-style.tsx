/** @jsxImportSource react */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "@/components/ui/sonner";
import type { OmniRushWorkAnswerStyle } from "@/app/lib/omnirush-server";
import { cn } from "@/lib/utils";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "@/react-app/domains/settings/settings-layout";

import { useWorkState, type WorkClient } from "./work-mode";

const OPTIONS: { value: OmniRushWorkAnswerStyle; label: string }[] = [
  { value: "brief", label: "Brief" },
  { value: "detailed", label: "Detailed" },
];

/** Settings > Work: "Answer style: Brief | Detailed" for Work chats. Shown only while Work is on for the account. */
export function WorkAnswerStyleSetting(props: { client: WorkClient | null }) {
  const queryClient = useQueryClient();
  const work = useWorkState(props.client);
  const key = ["omnirush-work-answer-style", props.client?.baseUrl?.trim() || "default"];
  const style = useQuery({ queryKey: key, queryFn: () => props.client!.getWorkAnswerStyle(), enabled: Boolean(props.client && work.data?.enabled) });
  const change = useMutation({
    mutationFn: (value: OmniRushWorkAnswerStyle) => props.client!.setWorkAnswerStyle(value),
    onSuccess: (answer) => queryClient.setQueryData(key, answer),
    onError: (reason) => toast.error(reason instanceof Error ? reason.message : "The answer style could not be saved."),
  });
  if (!work.data?.enabled || !style.data) return null;
  const current = change.isPending && change.variables ? change.variables : style.data.style;
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>Work answer style</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>
          How Work chats answer. Brief: short sentences and bullets, sources as links. Detailed: more context and options.
        </LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <div role="radiogroup" aria-label="Answer style" data-testid="work-answer-style" className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
            {OPTIONS.map((option) => (
              <button key={option.value} type="button" role="radio" aria-checked={current === option.value} data-answer-style={option.value}
                disabled={change.isPending} onClick={() => current !== option.value && change.mutate(option.value)}
                className={cn("h-7 rounded-md px-3 text-[12px] transition-colors",
                  current === option.value ? "bg-background font-semibold text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-border dark:bg-gray-5" : "text-muted-foreground hover:text-foreground")}>
                {option.label}
              </button>
            ))}
          </div>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
    </LayoutSectionItem>
  );
}
