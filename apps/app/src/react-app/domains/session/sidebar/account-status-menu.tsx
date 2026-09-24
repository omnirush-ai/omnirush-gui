/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  ChevronUp,
  LogOut,
  MessageCircleMore,
  MoreHorizontal,
  Settings,
  Stethoscope,
  UserRound,
} from "lucide-react";
import { useNavigate } from "react-router";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { usePlatform } from "../../../kernel/platform";
import { isDenSessionRestoring, useDenAuth } from "../../cloud/den-auth-provider";
import { useDenControlPlaneConfigured } from "../../cloud/use-den-control-plane-configured";
import { useDesktopRestriction } from "../../cloud/desktop-config-provider";
import { useControlAction, type OmniRushControlAction } from "../../../shell/control/control-provider";
import { useShellConfig } from "../../../shell/shell-config";
import type { OmniRushServerStatus } from "../../../../app/lib/omnirush-server";
import {
  buildDenAuthUrl,
  clearDenSession,
  createDenClient,
  readDenBootstrapConfig,
  readDenSettings,
} from "../../../../app/lib/den";
import { markDesktopSignInInitiated } from "../../../../app/lib/den-sign-in-intent";
import { exchangeHandoffAndSignIn } from "../../../../app/lib/den-handoff";
import { parseManualAuthInput } from "../../../../app/lib/manual-auth-input";
import {
  omniRushConnectAttentionTitle,
  resolveOmniRushConnectStatus,
  type OmniRushConnectStatus,
} from "../../connections/omnirush-connect-status";
import type { SessionCloudMcpMaintenanceState } from "../../connections/use-session-mcp-maintenance";

const DOCS_URL = "https://github.com/omnirush-ai/omnirush-gui#readme";
const BOOT_STARTED_AT = Date.now();
const INITIALIZING_MS = 15_000;

type StatusDotVariant = "connected" | "loading" | "partial" | "disconnected";

function StatusDot({ variant }: { variant: StatusDotVariant }) {
  return (
    <span className="relative flex size-2 shrink-0 items-center justify-center">
      {variant === "loading" ? (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-9/35" />
      ) : null}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          variant === "connected" && "bg-green-9",
          variant === "loading" && "bg-amber-9",
          variant === "partial" && "bg-amber-9",
          variant === "disconnected" && "bg-red-9",
        )}
      />
    </span>
  );
}

type RuntimeStatus = {
  variant: StatusDotVariant;
  label: string;
  detail: string | null;
};

type RuntimeStatusInput = {
  clientConnected: boolean;
  omnirushServerStatus: OmniRushServerStatus;
  initializing: boolean;
  reloadBusy?: boolean;
  reloadError?: string | null;
};

export function resolveRuntimeStatus(input: RuntimeStatusInput): RuntimeStatus {
  if (input.reloadBusy) {
    return {
      variant: "loading",
      label: t("status.reloading_config"),
      detail: t("config.reload_now_desc"),
    };
  }
  if (input.reloadError) {
    return { variant: "disconnected", label: t("system.reload_failed"), detail: input.reloadError };
  }
  // This row renders app-scoped facts only. Per-session loading (messages
  // still fetching, a model verdict still pending) stays in the pane and the
  // composer — one session's state must not paint the whole app as booting.
  if (input.omnirushServerStatus === "disconnected" && input.initializing) {
    return {
      variant: "loading",
      label: t("session.preparing_workspace"),
      detail: t("session.loading_detail"),
    };
  }
  if (input.clientConnected) {
    return { variant: "connected", label: t("status.ready_for_tasks"), detail: null };
  }
  if (input.omnirushServerStatus === "limited") {
    return { variant: "partial", label: t("status.limited_mode"), detail: t("status.limited_hint") };
  }
  return {
    variant: "disconnected",
    label: t("status.disconnected_label"),
    detail: t("status.disconnected_hint"),
  };
}

function connectDotVariant(status: OmniRushConnectStatus): StatusDotVariant {
  if (status.state === "ready") return "connected";
  if (status.state === "checking") return "loading";
  return "disconnected";
}

/**
 * Non-developer mode shows one status row: the runtime status, unless
 * omnirush.ai Connect needs attention (or is the only signal available).
 * Developer mode keeps the two separate rows.
 */
export function resolveCollapsedStatus(
  runtime: RuntimeStatus | null,
  connect: OmniRushConnectStatus | null,
): RuntimeStatus | null {
  if (runtime && runtime.variant !== "connected") return runtime;
  if (connect && connect.state === "needs_attention") {
    return {
      variant: "disconnected",
      label: `omnirush.ai Connect: ${connect.label}`,
      detail: connect.description,
    };
  }
  if (runtime) return runtime;
  if (connect) {
    return {
      variant: connectDotVariant(connect),
      label: `omnirush.ai Connect: ${connect.label}`,
      detail: connect.description,
    };
  }
  return null;
}

function accountInitials(name: string | null, email: string) {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export type AccountStatusMenuProps = {
  clientConnected: boolean;
  omnirushServerStatus: OmniRushServerStatus;
  developerMode: boolean;
  /** Hidden until a workspace is selected, matching the old status bar. */
  showConnectionStatus: boolean;
  providerConnectedIds: string[];
  mcpConnectedCount: number;
  reloadBusy?: boolean;
  reloadError?: string | null;
  omniRushConnectState?: SessionCloudMcpMaintenanceState;
  showSettingsButton?: boolean;
  onOpenAccountSettings?: () => void;
  onSendFeedback?: () => void;
};

/**
 * Sidebar footer control: the signed-in account plus the live status the app
 * used to show in a full-width bottom status bar.
 */
export function AccountStatusMenu(props: AccountStatusMenuProps) {
  const denAuth = useDenAuth();
  const platform = usePlatform();
  const navigate = useNavigate();
  const { config: shellConfig } = useShellConfig();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pasteCode, setPasteCode] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [manualAuthOpen, setManualAuthOpen] = useState(false);
  const denControlPlaneConfigured = useDenControlPlaneConfigured();
  const [initializing, setInitializing] = useState(
    () => Date.now() - BOOT_STARTED_AT < INITIALIZING_MS,
  );

  useEffect(() => {
    if (!initializing) return;
    const remaining = Math.max(0, INITIALIZING_MS - (Date.now() - BOOT_STARTED_AT));
    const timeout = window.setTimeout(() => setInitializing(false), remaining);
    return () => window.clearTimeout(timeout);
  }, [initializing]);

  const openSettings = props.onOpenAccountSettings;
  const openDocs = useCallback(() => platform.openLink(DOCS_URL), [platform]);
  // When the organization blocks settings control, the settings surface is the
  // Cloud account page only, so the entry is labelled for where it lands and
  // the Debug shortcut is hidden.
  // Reuses Den’s existing allowControlSettings boolean contract (PR #1838);
  // no new response field is required. Missing values retain the hook’s default.
  const controlSettingsBlocked = useDesktopRestriction("allowControlSettings");

  const docsControlAction = useMemo<OmniRushControlAction>(() => ({
    id: "status.docs.open",
    label: "Open omnirush.ai docs",
    description: "Open the documentation from the account menu.",
    sideEffect: "external",
    targetRef: triggerRef,
    execute: openDocs,
  }), [openDocs]);
  useControlAction(docsControlAction);

  const feedbackControlAction = useMemo<OmniRushControlAction>(() => ({
    id: "status.feedback.open",
    label: "Send feedback",
    description: "Open the omnirush.ai feedback surface from the account menu.",
    sideEffect: "external",
    disabled: !props.onSendFeedback,
    targetRef: triggerRef,
    execute: () => props.onSendFeedback?.(),
  }), [props.onSendFeedback]);
  useControlAction(feedbackControlAction);

  const settingsControlAction = useMemo<OmniRushControlAction>(() => ({
    id: "status.settings.open",
    label: "Open settings from the account menu",
    description: "Use the account menu in the sidebar footer.",
    sideEffect: "navigation",
    disabled: props.showSettingsButton === false || !openSettings,
    targetRef: triggerRef,
    execute: () => openSettings?.(),
  }), [openSettings, props.showSettingsButton]);
  useControlAction(settingsControlAction);

  const user = denAuth.user;
  const signedIn = denAuth.isSignedIn && user !== null;
  // A retained session still restores in the background; never flash "Sign
  // in". This covers both the initial check and a retained session whose
  // first check failed transiently (local server restart, control-plane
  // blip) and is being retried.
  const restoringSession = isDenSessionRestoring({
    status: denAuth.status,
    hasUser: user !== null,
  });
  const accountLabel = signedIn
    ? user.name?.trim() || user.email
    : restoringSession ? "omnirush.ai Cloud" : "Sign in";
  const accountDetail = signedIn
    ? (user.name ? user.email : "omnirush.ai Cloud")
    : restoringSession ? "Restoring your session" : "Sync with omnirush.ai Cloud";

  const runtimeStatus = props.showConnectionStatus
    ? resolveRuntimeStatus({
      clientConnected: props.clientConnected,
      omnirushServerStatus: props.omnirushServerStatus,
      initializing,
      reloadBusy: props.reloadBusy,
      reloadError: props.reloadError,
    })
    : null;
  const connectStatus = resolveOmniRushConnectStatus(
    denAuth.isSignedIn
      || (denAuth.status === "checking" && Boolean(readDenSettings().authToken?.trim())),
    props.omniRushConnectState,
  );
  const connectNeedsAttention = connectStatus?.state === "needs_attention";
  const collapsedStatus = resolveCollapsedStatus(runtimeStatus, connectStatus);
  const showStatus = shellConfig.statusBar && (runtimeStatus !== null || connectStatus !== null);

  const openSignIn = () => {
    let url: string;
    try {
      url = buildDenAuthUrl(readDenBootstrapConfig().baseUrl, "sign-up");
    } catch (error) {
      // No control plane configured: show the reason in the manual sign-in
      // panel (a pasted sign-in link carries its own server URL).
      setPasteError(error instanceof Error ? error.message : t("den.error_base_url"));
      setManualAuthOpen(true);
      return;
    }
    markDesktopSignInInitiated();
    platform.openLink(url);
  };

  const submitPastedCode = async () => {
    const parsed = parseManualAuthInput(pasteCode);
    if (!parsed) {
      setPasteError(t("den.error_paste_valid_code"));
      return;
    }
    setPasteBusy(true);
    setPasteError(null);
    markDesktopSignInInitiated();
    const nextBaseUrl = parsed.baseUrl ?? readDenSettings().baseUrl;
    const result = await exchangeHandoffAndSignIn(parsed.grant, {
      baseUrl: nextBaseUrl,
      desktopInitiated: true,
      fallbackErrorMessage: t("den.error_no_token"),
    });
    setPasteBusy(false);
    if (!result.ok) {
      setPasteError(result.error);
      return;
    }
    setPasteCode("");
    void denAuth.refresh();
  };

  const logOut = () => {
    const settings = readDenSettings();
    if (settings.authToken) {
      void createDenClient({
        baseUrl: settings.baseUrl,
        token: settings.authToken,
      })
        .signOut()
        .catch(() => undefined);
    }
    clearDenSession({ userInitiated: true });
    void denAuth.refresh();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            ref={triggerRef}
            type="button"
            data-testid="account-status-menu"
            data-runtime-state={runtimeStatus?.variant}
            data-connect-state={connectStatus?.state}
            /* ps-1.5 puts the 24px avatar 12px from the edge, so the name lands on the sidebar label lane. */
            className="flex w-full items-center gap-2 rounded-lg ps-1.5 pe-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent max-lg:min-h-11"
            aria-label={signedIn ? `${user.email} — account and status` : "Account and status"}
            title={connectNeedsAttention
              ? omniRushConnectAttentionTitle(connectStatus.description)
              : connectStatus
                ? `${runtimeStatus ? `${runtimeStatus.label} · ` : ""}omnirush.ai Connect: ${connectStatus.label}`
                : runtimeStatus?.label}
          >
              {signedIn ? (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                  {accountInitials(user.name, user.email)}
                </span>
              ) : (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground">
                  <UserRound size={13} />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-sidebar-foreground">
                  {accountLabel}
                </span>
                <span className="block truncate text-[10.5px] leading-tight text-muted-foreground">
                  {accountDetail}
                </span>
              </span>
              {connectNeedsAttention ? (
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <StatusDot variant="disconnected" />
                </span>
              ) : null}
              <MoreHorizontal size={14} className="shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent side="top" align="start" className="w-72">
        {signedIn ? (
          <div className="px-2 py-1.5 text-[11px] text-muted-foreground">{user.email}</div>
        ) : null}

        {showStatus ? (
          <div className="mx-1 mb-1 flex flex-col gap-2 rounded-lg bg-muted/50 p-2">
            {props.developerMode ? (
              <>
                {runtimeStatus ? (
                  <div className="flex items-start gap-2">
                    <span className="mt-1">
                      <StatusDot variant={runtimeStatus.variant} />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[11.5px] font-medium text-foreground">{runtimeStatus.label}</div>
                      {runtimeStatus.detail ? (
                        <div className="text-[10.5px] leading-tight text-muted-foreground">
                          {runtimeStatus.detail}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {connectStatus ? (
                  <div data-testid="omnirush-connect-status" className="flex items-start gap-2">
                    <span className="mt-1">
                      <StatusDot variant={connectDotVariant(connectStatus)} />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[11.5px] font-medium text-foreground">
                        {`omnirush.ai Connect: ${connectStatus.label}`}
                      </div>
                      <div className="text-[10.5px] leading-tight text-muted-foreground">
                        {connectStatus.description}
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            ) : collapsedStatus ? (
              <div data-testid="collapsed-status" className="flex items-start gap-2">
                <span className="mt-1">
                  <StatusDot variant={collapsedStatus.variant} />
                </span>
                <div className="min-w-0">
                  <div className="text-[11.5px] font-medium text-foreground">{collapsedStatus.label}</div>
                  {collapsedStatus.detail ? (
                    <div className="text-[10.5px] leading-tight text-muted-foreground">
                      {collapsedStatus.detail}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
            {props.showConnectionStatus && props.developerMode ? (
              <div className="text-[10.5px] leading-tight text-muted-foreground">
                {t("account.providers_connected", { count: props.providerConnectedIds.length })}
                {" · "}
                {t("account.mcp_connected", { count: props.mcpConnectedCount })}
                {` · ${t("status.developer_mode")}`}
              </div>
            ) : null}
          </div>
        ) : null}

        {connectNeedsAttention && !controlSettingsBlocked ? (
          <DropdownMenuItem onClick={() => navigate("/settings/debug")}>
            <Stethoscope className="size-3.5" />
            Run diagnostics
          </DropdownMenuItem>
        ) : null}
        {connectNeedsAttention && !controlSettingsBlocked ? <DropdownMenuSeparator /> : null}

        {props.showSettingsButton !== false ? (
          <DropdownMenuItem onClick={openSettings}>
            <Settings className="size-3.5" />
            {controlSettingsBlocked ? t("settings.tab_cloud_account") : t("status.settings")}
          </DropdownMenuItem>
        ) : null}
        {shellConfig.docsButton ? (
          <DropdownMenuItem onClick={openDocs}>
            <BookOpen className="size-3.5" />
            {t("status.docs")}
          </DropdownMenuItem>
        ) : null}
        {shellConfig.feedbackButton && props.onSendFeedback ? (
          <DropdownMenuItem onClick={props.onSendFeedback}>
            <MessageCircleMore className="size-3.5" />
            {t("status.feedback")}
          </DropdownMenuItem>
        ) : null}
        {signedIn ? (
          <DropdownMenuItem onClick={logOut}>
            <LogOut className="size-3.5" />
            Log out
          </DropdownMenuItem>
        ) : shellConfig.cloudSignin && !restoringSession ? (
          <div
            className="flex flex-col gap-2 px-2 py-2"
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {denControlPlaneConfigured ? (
              <Button
                type="button"
                className="h-11 w-full justify-between px-3 text-sm"
                onClick={openSignIn}
                data-testid="account-cloud-signin-button"
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  <UserRound className="size-3.5" />
                  <span className="truncate">Sign in to omnirush.ai Cloud</span>
                </span>
                <ArrowUpRight className="size-3.5" />
              </Button>
            ) : null}

            <button
              type="button"
              className="flex h-8 w-full items-center justify-between rounded-xl px-2 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              onClick={() => setManualAuthOpen((open) => !open)}
              aria-expanded={manualAuthOpen}
              aria-controls="account-manual-auth-panel"
            >
              <span>
                {manualAuthOpen ? t("den.hide_signin_code") : t("den.paste_signin_code")}
              </span>
              {manualAuthOpen ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </button>

            {manualAuthOpen ? (
              <div id="account-manual-auth-panel" className="flex flex-col gap-2">
                <label htmlFor="account-paste-signin-code" className="text-[11px] text-muted-foreground">
                  {t("den.signin_link_label")}
                </label>
                <Input
                  id="account-paste-signin-code"
                  value={pasteCode}
                  onChange={(event) => {
                    setPasteCode(event.currentTarget.value);
                    if (pasteError) setPasteError(null);
                  }}
                  placeholder={t("den.signin_link_placeholder")}
                  className="h-11 text-base lg:h-9 lg:text-sm"
                  disabled={pasteBusy}
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-11 max-lg:h-11"
                  disabled={pasteBusy || !pasteCode.trim()}
                  onClick={() => void submitPastedCode()}
                >
                  {pasteBusy ? t("den.finishing") : t("den.finish_signin")}
                </Button>
                {pasteError ? (
                  <p className="text-[11px] text-destructive">{pasteError}</p>
                ) : (
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    {t("den.signin_link_hint")}
                  </p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
