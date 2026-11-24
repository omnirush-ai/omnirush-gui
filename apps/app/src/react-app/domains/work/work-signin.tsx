import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";

import { t } from "../../../i18n";
import { omnirushAccountConnect, omnirushAccountStatus } from "../../../app/lib/desktop";
import { captureAnalyticsEvent } from "../../../app/lib/analytics";
import { refreshAccountStatus } from "../../../app/lib/quality";
import { isDesktopRuntime } from "../../../app/utils";
import { cn } from "@/lib/utils";

import { useWorkModeStore, useWorkSignInRequest, WORK_HOME_ROUTE } from "./work-mode";

export type WorkSignInState = { busy: boolean; error: string | null; start: () => Promise<void> };

/** Sign in to OmniRush Work (the company portal account) from the desktop app: the browser approves it, then the app
 *  opens Work. The welcome page has its own copy for the web build; the desktop never shows that page. */
export function useWorkSignIn(): WorkSignInState {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const start = useCallback(async () => {
    setState({ busy: true, error: null });
    try {
      await omnirushAccountConnect({ surface: "work" });
      captureAnalyticsEvent("sign_in_completed", { method: "device_link", surface: "work" });
      void refreshAccountStatus(omnirushAccountStatus);
      // The Work switch and the company are read again for the new account.
      await queryClient.invalidateQueries();
      useWorkModeStore.getState().setMode("work");
      setState({ busy: false, error: null });
      navigate(WORK_HOME_ROUTE);
    } catch {
      setState({ busy: false, error: t("welcome.sign_in_work_failed") });
    }
  }, [navigate, queryClient]);
  return { ...state, start };
}

/** Desktop: `omnirush://work/signin` (the company portal's "Open the app") starts the Work sign-in at once. */
export function WorkSignInListener() {
  if (!isDesktopRuntime()) return null;
  return <WorkSignInRequestHandler />;
}

function WorkSignInRequestHandler() {
  const signIn = useWorkSignIn();
  const requested = useWorkSignInRequest((store) => store.requested);
  useEffect(() => {
    if (!requested || signIn.busy) return;
    useWorkSignInRequest.getState().setRequested(false);
    void signIn.start();
  }, [requested, signIn]);
  return null;
}

/** The "Sign in to OmniRush Work" choice next to the desktop's own sign-in (account menu, Settings > General). Only on the
 *  desktop, only while signed out. */
export function WorkSignInChoice(props: { className?: string }) {
  const signIn = useWorkSignIn();
  if (!isDesktopRuntime()) return null;
  return (
    <div className={cn("flex flex-col gap-1", props.className)}>
      <button
        type="button"
        disabled={signIn.busy}
        onClick={() => void signIn.start()}
        className="flex h-9 w-full items-center gap-2 rounded-lg border border-border px-3 text-start text-[13px] font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        data-testid="work-signin-choice"
      >
        <Building2 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{signIn.busy ? t("welcome.sign_in_work_waiting") : t("welcome.sign_in_work")}</span>
      </button>
      {signIn.error ? <div role="alert" className="text-[12px] text-destructive" data-testid="work-signin-error">{signIn.error}</div> : null}
    </div>
  );
}
