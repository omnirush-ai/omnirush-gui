/** @jsxImportSource react */
import * as React from "react";
import {
  Blocks,
  Globe,
  Loader2,
  Maximize2,
  Plus,
  X,
} from "lucide-react";
import { useDragControls } from "motion/react";

import type { OmniRushServerClient } from "@/app/lib/omnirush-server";
import { PanelTab, PanelTabClose, PanelTabItem, PanelTabList } from "@/components/panel-tabs";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";

import { ArtifactIcon } from "../artifacts/artifact-icon";
import { AppArtifact } from "../../apps/app-artifact";
import { ArtifactPanel } from "../artifacts/artifact-panel";
import {
  type BrowserPanelTab,
  usePanelTabStore,
  type PanelTab as PanelTabEntry,
  useActivePanelTab,
  useSessionPanelState,
} from "./panel-tab-store";
import { useControlAction, type OmniRushControlAction } from "../../../shell/control/control-provider";
import type { OpenTarget } from "../artifacts/open-target";
import { useSidePanelTabs } from "./use-side-panel-tabs";
import { handlePanelEscape, PanelEmpty } from "./panel-empty";
import { BrowserLibraryBar } from "./browser-library-bar";
import {
  agentWorkingIn,
  BrowserAddressField,
  BrowserAgentStrip,
  BrowserApprovalOverlay,
  BrowserNavButtons,
  BrowserPageStill,
  BrowserSuspendedNotice,
  reportBrowserError,
  useNativeBrowserView,
} from "./browser-surface";
import { BrowserSignInBar } from "./browser-signin-bar";
import { NO_SESSION_SIDE_PANEL_KEY } from "./side-panel-session";
import {
  getElectronBrowser,
  getNativeMenuPoint,
} from "./utils";
import { LoginSyncCard, useImportOfferVisit } from "../../browser-logins/login-sync-card";
import { useBrowserLibraryAvailable } from "../../browser-logins/use-browser-library";
import { BrowserHome } from "../../work/browser/browser-home";
import { TabMark } from "../../work/browser/tab-mark";
import { useCompanyApps } from "../../work/browser/use-work-browser";
import { isBrowserHomeTab, WORK_BROWSER_EXPAND_EVENT } from "../../work/browser/work-browser";
import { RecordPanel, RecordTabIcon } from "../../work/viewer/record-panel-entry";

type SidePanelProps = {
  sessionId: string;
  client: OmniRushServerClient | null;
  workspaceId: string | null;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  onClose: () => void;
  onOpenExtensions?: () => void;
};

// HMR can remount this module without unmounting BrowserPanelContent, leaving
// the native Electron browser overlay visible — hide it before the module reloads.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    getElectronBrowser()?.hide?.();
  });
}

const MARKDOWN_PRIMITIVE_ARTIFACT_CONTENT = `# Artifact Markdown Proof

The artifact preview keeps **outside-chat Markdown** readable with inline \`surface renderer\`, a fenced code block, and [omnirush.ai](https://omnirush.ai).

\`\`\`ts
const surface = "shared markdown primitive";
console.log(surface);
\`\`\`

\`\`\`mermaid
flowchart LR
  ArtifactStart[Artifact Mermaid Start] --> ArtifactFinish[Artifact Mermaid Finish]
\`\`\``;

const STANDALONE_MERMAID_ARTIFACT_CONTENT = `flowchart TD
  StandaloneStart[Standalone Mermaid] --> StandaloneFinish[Rendered artifact]`;

type SidePanelTabProps = {
  tab: PanelTabEntry;
  active: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tab: PanelTabEntry) => void;
};

function SidePanelTab({ tab, active, onSelect, onClose }: SidePanelTabProps) {
  const dragControls = useDragControls();
  // The person's own tabs beside Work: the same marks as the Work browser (never an empty icon).
  const work = useBrowserLibraryAvailable();
  const tabRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (active) {
      tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [active]);

  const showBrowserTabContextMenu = (point?: { clientX: number; clientY: number }) => {
    void getElectronBrowser()?.showTabContextMenu?.(
      tab.id,
      getNativeMenuPoint(tabRef.current, point),
    );
  };

  return (
    <PanelTabItem
      value={tab.id}
      id={tab.id}
      // A record's title gets room (up to 220 px) before it ends in an ellipsis; other tabs keep their width.
      className={tab.type === "record" ? "w-auto min-w-36 max-w-[220px]" : undefined}
      dragControls={tab.type === "browser" ? dragControls : undefined}
      onContextMenu={tab.type === "browser" ? (event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        showBrowserTabContextMenu({ clientX: event.clientX, clientY: event.clientY });
      } : undefined}
    >
      <div ref={tabRef} className="relative">
        <PanelTab
          active={active}
          onClick={() => onSelect(tab.id)}
          onPointerDown={tab.type === "browser" ? (event) => {
            if (event.button !== 0) {
              return;
            }

            dragControls.start(event);
          } : undefined}
          onKeyDown={tab.type === "browser" ? (event: React.KeyboardEvent<HTMLButtonElement>) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
              return;
            }

            event.preventDefault();
            showBrowserTabContextMenu();
          } : undefined}
          title={tab.label}
          aria-label={`Select tab: ${tab.label}`}
        >
          {tab.type === "browser" ? (
            work && tab.ownerSessionId === NO_SESSION_SIDE_PANEL_KEY ? <TabMark tab={tab} /> : tab.favicon ? (
              <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-[2px]" />
            ) : tab.status === "loading" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Globe />
            )
          ) : tab.type === "app" ? <Blocks /> : tab.type === "record" ? <RecordTabIcon tab={tab} /> : (
            <ArtifactIcon type={tab.preview} />
          )}
          <span className="min-w-0 flex-1 truncate text-left" title={tab.type === "record" ? tab.label : undefined}>{tab.label}</span>
        </PanelTab>
        <PanelTabClose
          active={active}
          label={tab.label}
          onClose={() => onClose(tab)}
        />
      </div>
    </PanelTabItem>
  );
}

type BrowserPanelContentProps = {
  sessionId: string;
  tab: BrowserPanelTab;
  onClose: () => void;
};

function BrowserPanelContent({
  sessionId,
  tab,
  onClose,
}: BrowserPanelContentProps) {
  const suspended = tab.status === "suspended";
  const contentRef = React.useRef<HTMLDivElement>(null);
  const urlInputRef = React.useRef<HTMLInputElement>(null);
  // A Work account's own tabs (Work pages, no conversation): a new tab shows Browser home, Expand moves the tab to
  // the Work browser, the agent strip shows only while an agent works in the tab, and a menu over the page leaves a
  // picture of it in place.
  const work = useBrowserLibraryAvailable();
  const userTabs = work && sessionId === NO_SESSION_SIDE_PANEL_KEY;
  const home = work && isBrowserHomeTab(tab);
  const [still, setStill] = React.useState<string | null>(null);
  const isAvailable = useNativeBrowserView(contentRef, sessionId, false, userTabs ? { onStill: setStill } : undefined);

  const suspend = React.useCallback(() => {
    void getElectronBrowser()?.suspendTab?.(tab.id).catch(reportBrowserError);
  }, [tab.id]);

  return (
    <>
      {isAvailable && (!userTabs || agentWorkingIn(tab)) ? <BrowserAgentStrip tab={tab} /> : null}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-background px-2 mac:bg-background/80 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
        {isAvailable ? (
          <>
            <BrowserNavButtons tab={tab} />
            <BrowserAddressField tab={tab} inputRef={urlInputRef} blankAsEmpty={work} compact={userTabs} placeholder={userTabs ? t("work_browser.address") : undefined} />
            <BrowserLibraryBar sessionId={sessionId} tab={tab} inputRef={urlInputRef} />
            {/* Beside Work pages the panel is narrow and the tab moves to the Work browser with Expand, where ".." has Suspend. */}
            {userTabs ? null : (
              <Button
                variant="ghost"
                size="sm"
                onClick={suspend}
                disabled={tab.status !== "ready" || tab.automationProtected}
                title={tab.automationProtected ? "Protected until browser work is released" : "Suspend this tab to free memory"}
              >
                Suspend
              </Button>
            )}
            {tab.siteToolCount > 0 ? (
              <Popover>
                <PopoverTrigger
                  render={(
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-6 shrink-0 rounded-md bg-muted/60 px-2 text-[11px] font-medium"
                      aria-label={`${tab.siteToolCount} site ${tab.siteToolCount === 1 ? "tool" : "tools"} available; inspect site tools and activity`}
                    >
                      {tab.siteToolCount} {tab.siteToolCount === 1 ? "tool" : "tools"}
                    </Button>
                  )}
                />
                <PopoverContent align="end" side="bottom" sideOffset={8} className="w-80 max-w-[calc(100vw-2rem)] gap-0 p-0">
                  <div className="border-b border-border px-4 py-3">
                    <p className="text-sm font-semibold">Site tools</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Actions offered by this page. Review the website and the requested action before allowing it.
                    </p>
                  </div>
                  <div className="max-h-64 overflow-y-auto px-4 py-2">
                    {(tab.siteTools ?? []).map((tool) => (
                      <div key={`${tool.origin}:${tool.name}`} className="border-b border-border/60 py-2 last:border-b-0">
                        <div className="flex items-center justify-between gap-3">
                          <p className="min-w-0 truncate text-xs font-medium">{tool.title || tool.name}</p>
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {tool.readOnly ? "Site says read-only" : "May change data"}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{tool.name}</p>
                        <p className="truncate text-[10px] text-muted-foreground">{tool.origin}</p>
                      </div>
                    ))}
                  </div>
                  {(tab.siteToolActivity ?? []).length > 0 ? (
                    <div className="border-t border-border px-4 py-3">
                      <p className="mb-1.5 text-xs font-semibold">Recent activity</p>
                      {(tab.siteToolActivity ?? []).slice(0, 5).map((activity, index) => (
                        <div key={`${activity.at}:${activity.name}:${index}`} className="flex items-center justify-between gap-3 py-1 text-[10px]">
                          <span className="min-w-0 truncate font-mono">{activity.name}</span>
                          <span className={activity.status === "completed" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
                            {activity.status === "completed" ? "Returned" : activity.code || "Failed"}
                          </span>
                        </div>
                      ))}
                      <p className="mt-1 text-[10px] text-muted-foreground">Arguments and results are not retained in this activity view.</p>
                    </div>
                  ) : null}
                </PopoverContent>
              </Popover>
            ) : null}
            {userTabs ? (
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => window.dispatchEvent(new Event(WORK_BROWSER_EXPAND_EVENT))}
                      aria-label={t("work_browser.expand")}
                      data-testid="browser-expand"
                    >
                      <Maximize2 />
                    </Button>
                  )}
                />
                <TooltipContent>{t("work_browser.expand")}</TooltipContent>
              </Tooltip>
            ) : null}
          </>
        ) : (
          <p className="px-2 text-sm text-muted-foreground">
            Browser panel is only available in the desktop app.
          </p>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          title="Close panel"
          aria-label="Close panel"
        >
          <X />
        </Button>
      </div>
      {isAvailable ? <BrowserSignInBar tab={tab} /> : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {isAvailable ? (
          <div ref={contentRef} className="relative h-full overflow-hidden">
            {suspended ? <BrowserSuspendedNotice tab={tab} /> : null}
            {userTabs && !suspended && !home ? <BrowserPageStill still={still} /> : null}
          </div>
        ) : null}
        {isAvailable && home ? (
          <div className="absolute inset-0">
            <PanelBrowserHome sessionId={sessionId} />
          </div>
        ) : null}
        <BrowserApprovalOverlay tab={tab} />
      </div>
    </>
  );
}

/** Browser home in a narrow panel: tiles open in this tab, Cmd or Ctrl click in a new one. */
function PanelBrowserHome({ sessionId }: { sessionId: string }) {
  const company = useCompanyApps();
  const open = React.useCallback((url: string, options?: { newTab?: boolean }) => {
    const browser = getElectronBrowser();
    void (options?.newTab ? browser?.createTab?.(url, sessionId) : browser?.navigate?.(url))?.catch(reportBrowserError);
  }, [sessionId]);
  return <BrowserHome compact companyName={company.companyName} apps={company.apps} onOpen={open} />;
}

// A menu or dialog over the page (the Work browser's home is the page itself, not a cover).
const PAGE_COVER_SELECTOR = '[data-browser-occluder]:not([data-testid="browser-home"]), [role="dialog"], [role="alertdialog"]';

export function SidePanel({
  sessionId,
  client,
  workspaceId,
  workspaceRoot,
  isRemoteWorkspace = false,
  onClose,
  onOpenExtensions,
}: SidePanelProps) {
  const { tabs } = useSessionPanelState(sessionId);
  const activeTab = useActivePanelTab(sessionId);
  const isBrowserAvailable = Boolean(getElectronBrowser());
  // Beside Work pages (the person's own tabs): one look at the import offer per time the panel is open.
  const userPanel = useBrowserLibraryAvailable() && sessionId === NO_SESSION_SIDE_PANEL_KEY;
  useImportOfferVisit(userPanel);

  const { createTab, closeTab, selectTab, reorderTabs } = useSidePanelTabs(sessionId);

  const seedArtifactOverflowControlAction = React.useMemo<OmniRushControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.artifact_tabs.seed_overflow",
      label: "Seed artifact tab overflow eval data",
      description: "Create many markdown artifacts and open them in the right-side artifact tab strip.",
      sideEffect: "mutation",
      disabled: !client || !workspaceId,
      args: [
        { name: "count", type: "number", description: "Number of artifact tabs to create." },
        { name: "longNameLast", type: "boolean", description: "Give the last (active) artifact a very long filename to exercise header truncation." },
      ],
      previewArgs: { count: 18 },
      execute: async (args) => {
        if (!client || !workspaceId) return { ok: false, error: "Workspace client is not ready." };

        let count = 18;
        if (args && typeof args === "object" && "count" in args && typeof args.count === "number") {
          count = Math.max(12, Math.min(30, Math.floor(args.count)));
        }
        const longNameLast = Boolean(args && typeof args === "object" && "longNameLast" in args && args.longNameLast);

        const targets: OpenTarget[] = [];
        const store = usePanelTabStore.getState();

        for (let index = 1; index <= count; index += 1) {
          const padded = String(index).padStart(2, "0");
          const baseName = longNameLast && index === count
            ? `omnirush-self-managed-subscription-and-licensing-overview-very-long-${padded}`
            : `overflow-tab-${padded}`;
          const value = `artifacts/${baseName}.md`;
          const label = `${baseName}.md`;
          const content = `# Overflow tab ${padded}\n\nGenerated by the artifact tab overflow eval.\n`;

          await client.writeWorkspaceFile(workspaceId, { path: value, content, baseUpdatedAt: null });

          const target: OpenTarget = {
            id: `file:${value}`,
            kind: "file",
            value,
            name: label,
            preview: "markdown",
            confidence: 100,
            reason: "eval",
            exists: true,
            size: content.length,
          };

          targets.push(target);
          store.openTab(sessionId, {
            id: target.id,
            type: "artifact",
            label: target.name,
            preview: target.preview,
          });
        }

        store.syncTranscriptArtifacts(sessionId, targets);
        store.selectTab(sessionId, targets[targets.length - 1]?.id ?? "");

        return { ok: true, count: targets.length, activeTabId: targets[targets.length - 1]?.id ?? null };
      },
    };
  }, [client, sessionId, workspaceId]);
  useControlAction(seedArtifactOverflowControlAction);

  const seedMarkdownPrimitiveArtifactControlAction = React.useMemo<OmniRushControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.markdown_primitive.seed_artifact",
      label: "Seed markdown primitive artifact proof",
      description: "Create a deterministic markdown artifact and open it in the preview panel.",
      sideEffect: "mutation",
      disabled: !client || !workspaceId,
      execute: async (args) => {
        if (!client || !workspaceId) return { ok: false, error: "Workspace client is not ready." };

        const standalone = Boolean(args && typeof args === "object" && "standalone" in args && args.standalone);
        const value = standalone ? "artifacts/standalone-mermaid-proof.mmd" : "artifacts/markdown-primitive-proof.md";
        const name = standalone ? "standalone-mermaid-proof.mmd" : "markdown-primitive-proof.md";
        const content = standalone ? STANDALONE_MERMAID_ARTIFACT_CONTENT : MARKDOWN_PRIMITIVE_ARTIFACT_CONTENT;
        await client.writeWorkspaceFile(workspaceId, {
          path: value,
          content,
          baseUpdatedAt: null,
        });

        const target: OpenTarget = {
          id: `file:${value}`,
          kind: "file",
          value,
          name,
          preview: "markdown",
          confidence: 100,
          reason: "eval",
          exists: true,
          size: content.length,
        };

        const store = usePanelTabStore.getState();
        store.syncTranscriptArtifacts(sessionId, [target]);
        store.openTab(sessionId, { id: target.id, type: "artifact", label: target.name, preview: target.preview });
        store.selectTab(sessionId, target.id);

        return { ok: true, activeTabId: target.id, path: value };
      },
    };
  }, [client, sessionId, workspaceId]);
  useControlAction(seedMarkdownPrimitiveArtifactControlAction);

  const seedPdfArtifactControlAction = React.useMemo<OmniRushControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.artifact_tabs.seed_pdf",
      label: "Seed a PDF artifact",
      description: "Write a small valid PDF and open it as an artifact tab to verify inline PDF rendering.",
      sideEffect: "mutation",
      disabled: !client || !workspaceId,
      execute: async () => {
        if (!client || !workspaceId) return { ok: false, error: "Workspace client is not ready." };

        // Minimal single-page PDF that draws "omnirush.ai PDF" — base64 encoded.
        const pdfBase64 =
          "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAzMDAgMTQ0XS9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNCAwIFI+Pj4+L0NvbnRlbnRzIDUgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCjUgMCBvYmoKPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUCi9GMSAyNCBUZgo3MiA3MCBUZAooT3BlbldvcmsgUERGKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzEyIDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA2L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKNDA2CiUlRU9G";
        const binary = atob(pdfBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

        const value = "artifacts/sample-document.pdf";
        await client.writeWorkspaceBinaryFile(workspaceId, { path: value, data: bytes.buffer, baseUpdatedAt: null });

        const target: OpenTarget = {
          id: `file:${value}`,
          kind: "file",
          value,
          name: "sample-document.pdf",
          preview: "pdf",
          confidence: 100,
          reason: "eval",
          exists: true,
          size: bytes.length,
        };

        const store = usePanelTabStore.getState();
        store.syncTranscriptArtifacts(sessionId, [target]);
        store.openTab(sessionId, { id: target.id, type: "artifact", label: target.name, preview: target.preview });
        store.selectTab(sessionId, target.id);

        return { ok: true, activeTabId: target.id };
      },
    };
  }, [client, sessionId, workspaceId]);
  useControlAction(seedPdfArtifactControlAction);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key !== "Tab" || tabs.length < 2) {
        return;
      }

      const activeIndex = activeTab ? tabs.findIndex((tab) => tab.id === activeTab.id) : -1;
      if (activeIndex === -1) {
        return;
      }

      event.preventDefault();
      const offset = event.shiftKey ? -1 : 1;
      selectTab(tabs[(activeIndex + offset + tabs.length) % tabs.length].id);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab, selectTab, tabs]);

  return (
    <TooltipProvider delay={1000}>
      <div
        className="flex h-full flex-col"
        onKeyDownCapture={(event) => {
          // Beside Work pages, Escape in a menu or dialog over the page (bookmarks, suggestions) closes that menu and
          // keeps the panel. A chat's panel closes as before.
          if (userPanel && event.key === "Escape" && event.target instanceof Element && event.target.closest(PAGE_COVER_SELECTOR)) return;
          if (!handlePanelEscape(event.key, onClose)) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div className="shrink-0 border-b border-border bg-background mac:bg-background/80 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
          <div className="flex h-10 items-center gap-1 border-b border-border/60 px-2">
            <div className="no-scrollbar min-w-0 flex-1 overflow-x-auto">
              <PanelTabList
                values={tabs.map((tab) => tab.id)}
                onReorder={reorderTabs}
              >
                {tabs.map((tab) => (
                  <SidePanelTab
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeTab?.id}
                    onSelect={selectTab}
                    onClose={closeTab}
                  />
                ))}
              </PanelTabList>
            </div>
            {!activeTab ? <span className="sr-only">Panel destinations</span> : null}
            {activeTab && isBrowserAvailable ? (
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => createTab()}
                      aria-label="New tab"
                    >
                      <Plus />
                    </Button>
                  )}
                />
                <TooltipContent>New tab</TooltipContent>
              </Tooltip>
            ) : !activeTab ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                aria-label="Close panel"
              >
                <X />
              </Button>
            ) : null}
          </div>
        </div>
        {!activeTab ? (
          <PanelEmpty
            onOpenBrowser={isBrowserAvailable ? createTab : undefined}
            onOpenExtensions={onOpenExtensions}
          />
        ) : null}
        {activeTab?.type === "browser" ? (
          <>
            <LoginSyncCard visit={userPanel} hidden={Boolean(activeTab.blockedSignIn)} />
            <BrowserPanelContent sessionId={sessionId} tab={activeTab} onClose={onClose} />
          </>
        ) : activeTab?.type === "record" ? (
          <div className="min-h-0 flex-1 overflow-hidden"><RecordPanel key={activeTab.id} panelKey={sessionId} tab={activeTab} client={client} onClose={onClose} /></div>
        ) : activeTab?.type === "app" ? (
          <div className="min-h-0 flex-1 overflow-hidden"><AppArtifact key={activeTab.id} appId={activeTab.appId} revisionId={activeTab.revisionId} receiptId={activeTab.receiptId} onClose={onClose} /></div>
        ) : activeTab?.type === "artifact" ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <ArtifactPanel
              sessionId={sessionId}
              tab={activeTab}
              client={client}
              workspaceId={workspaceId}
              workspaceRoot={workspaceRoot}
              isRemoteWorkspace={isRemoteWorkspace}
              onClose={onClose}
            />
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
