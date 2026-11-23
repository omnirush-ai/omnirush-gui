/** @jsxImportSource react */
import { CircleHelp, ExternalLink } from "lucide-react";
import { create } from "zustand";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import {
  ALLOWANCE_GUIDE_GOOD_SESSION_URL,
  ALLOWANCE_GUIDE_URL,
  ALLOWANCE_HELP_LINK,
  ALLOWANCE_HELP_TITLE,
  ALLOWANCE_SECTIONS,
  GOOD_SESSION_HELP_TITLE,
  GOOD_SESSION_SECTIONS,
  utcMidnightLocal,
  type HelpSection,
} from "../../../app/lib/allowance-help";
import { openDesktopUrl } from "../../../app/lib/desktop";
import { omnirushUsageSummary } from "../../../app/lib/omnirush-usage";
import { useAccountStatusStore } from "../../../app/lib/quality";
import { useEnterpriseFlags } from "../work/enterprise-mode";

export type AllowanceHelpTab = "allowance" | "good-session";

type AllowanceHelpStore = {
  tab: AllowanceHelpTab | null;
  open: (tab?: AllowanceHelpTab) => void;
  close: () => void;
};

/** Which tab of the help is open (null: closed); any surface can open it. */
export const useAllowanceHelpStore = create<AllowanceHelpStore>((set) => ({
  tab: null,
  open: (tab = "allowance") => set({ tab }),
  close: () => set({ tab: null }),
}));

export function openAllowanceHelp(tab: AllowanceHelpTab = "allowance") {
  useAllowanceHelpStore.getState().open(tab);
}

function Sections({ sections }: { sections: readonly HelpSection[] }) {
  return (
    <>
      {sections.map((section) => (
        <section key={section.id} data-help-section={section.id} className="space-y-1.5">
          <h3 className="text-[13px] font-medium text-foreground">{section.title}</h3>
          {section.text ? <p className="text-xs leading-5 text-muted-foreground">{section.text}</p> : null}
          {section.points?.length ? (
            <ul className="list-disc space-y-1 ps-4 text-xs leading-5 text-muted-foreground marker:text-muted-foreground/60">
              {section.points.map((point) => <li key={point}>{point}</li>)}
            </ul>
          ) : null}
        </section>
      ))}
    </>
  );
}

/** The help body: the account's own line, then the two tabs (also rendered by the tests). */
export function AllowanceHelpBody(props: {
  tab: AllowanceHelpTab;
  onTabChange?: (tab: AllowanceHelpTab) => void;
  usageLine?: string | null;
  resetLocal?: string;
}) {
  const reset = props.resetLocal ?? utcMidnightLocal();
  return (
    <Tabs value={props.tab} onValueChange={(value) => props.onTabChange?.(value as AllowanceHelpTab)} className="min-h-0 gap-3">
      <TabsList className="w-full">
        <TabsTrigger value="allowance" data-testid="allowance-help-tab-allowance">Your tokens</TabsTrigger>
        <TabsTrigger value="good-session" data-testid="allowance-help-tab-good-session">Good session</TabsTrigger>
      </TabsList>
      <TabsContent value="allowance" className="space-y-4">
        <div className="rounded-xl border border-border px-3 py-2 text-xs leading-5" data-testid="allowance-help-now">
          {props.usageLine ? <p className="text-foreground">{props.usageLine}</p> : null}
          <p className="text-muted-foreground">
            Daily tokens refill at 00:00 UTC, which is {reset} on your clock.
          </p>
        </div>
        <Sections sections={ALLOWANCE_SECTIONS} />
      </TabsContent>
      <TabsContent value="good-session" className="space-y-4">
        <Sections sections={GOOD_SESSION_SECTIONS} />
      </TabsContent>
    </Tabs>
  );
}

/** The help dialog, mounted once over the app. */
export function AllowanceHelpDialog() {
  // The consumer allowance's help: never over an OmniRush Work company account (it has no allowance to explain).
  const enterprise = useEnterpriseFlags().on;
  const opened = useAllowanceHelpStore((store) => store.tab);
  const tab = enterprise ? null : opened;
  const status = useAccountStatusStore((store) => store.status);
  const usageLine = tab && status?.connected && status.usage ? omnirushUsageSummary(status.usage).line : null;
  const link = tab === "good-session" ? ALLOWANCE_GUIDE_GOOD_SESSION_URL : ALLOWANCE_GUIDE_URL;
  return (
    <Dialog open={tab !== null} onOpenChange={(open) => { if (!open) useAllowanceHelpStore.getState().close(); }}>
      <DialogContent className="gap-4 lg:max-w-lg" data-testid="allowance-help">
        <div className="pe-8">
          <DialogTitle className="text-base">{tab === "good-session" ? GOOD_SESSION_HELP_TITLE : ALLOWANCE_HELP_TITLE}</DialogTitle>
          <DialogDescription className="text-xs">
            {tab === "good-session" ? "What the Good session check looks for." : "How tokens are counted, when they reset, and what changes them."}
          </DialogDescription>
        </div>
        <div className="max-h-[60vh] overflow-y-auto pe-1">
          {tab ? <AllowanceHelpBody tab={tab} usageLine={usageLine} onTabChange={(next) => useAllowanceHelpStore.getState().open(next)} /> : null}
        </div>
        <button
          type="button"
          data-testid="allowance-help-guide"
          onClick={() => void openDesktopUrl(link)}
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline"
        >
          Read the full guide on omnirush.ai
          <ExternalLink className="size-3" aria-hidden="true" />
        </button>
      </DialogContent>
    </Dialog>
  );
}

/** A small text link that opens the help ("How tokens work"). */
export function AllowanceHelpLink(props: { tab?: AllowanceHelpTab; label?: string; className?: string; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={props.testId ?? "allowance-help-link"}
      onClick={() => openAllowanceHelp(props.tab)}
      className={cn(
        "inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 transition hover:text-foreground hover:underline",
        props.className,
      )}
    >
      <CircleHelp className="size-3 shrink-0" aria-hidden="true" />
      {props.label ?? ALLOWANCE_HELP_LINK}
    </button>
  );
}
