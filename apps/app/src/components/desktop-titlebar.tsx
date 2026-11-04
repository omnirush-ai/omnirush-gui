/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";
import "@/app/lib/desktop";

export function DesktopTitlebar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.__OMNIRUSH_ELECTRON__?.windowControls : undefined;
    if (!bridge) return;

    void bridge.isMaximized().then(setIsMaximized);
    return bridge.onMaximizedChange?.((max: boolean) => {
      setIsMaximized(max);
    });
  }, []);

  const bridge = typeof window !== "undefined" ? window.__OMNIRUSH_ELECTRON__?.windowControls : undefined;

  const handleMinimize = () => {
    void bridge?.minimize();
  };

  const handleMaximize = () => {
    void bridge?.maximize();
  };

  const handleClose = () => {
    void bridge?.close();
  };

  const handleNavBack = () => {
    window.history.back();
  };

  const handleNavForward = () => {
    window.history.forward();
  };

  return (
    <header className="hidden windows:flex relative z-50 h-8 w-full shrink-0 select-none items-center justify-between border-b border-border/30 bg-sidebar pl-3 pr-0 text-xs text-foreground/80 titlebar-drag">
      {/* Top-left: Sidebar Header Alignment (Brand + History Navigation) */}
      <div className="flex h-full w-60 items-center justify-between pr-2">
        <div className="flex items-center gap-2 select-none pointer-events-none pl-1">
          <img src={resolveExtensionIconSrc("/omnirush-mark.png")} className="size-5 shrink-0 object-contain dark:invert" alt="" />
          <span className="truncate text-[15px] font-medium tracking-[-0.4px] text-foreground" aria-label="omnirush.ai">
            <span>omnirush</span><span className="text-highlight">.ai</span>
          </span>
        </div>

        {/* Previous and Forward Navigation Arrows */}
        <div className="flex items-center gap-0.5 titlebar-no-drag">
          <button
            type="button"
            onClick={handleNavBack}
            className="flex size-6 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground cursor-pointer focus:outline-none"
            title="Back"
            aria-label="Back"
          >
            <ArrowLeft size={14} />
          </button>
          <button
            type="button"
            onClick={handleNavForward}
            className="flex size-6 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground cursor-pointer focus:outline-none"
            title="Forward"
            aria-label="Forward"
          >
            <ArrowRight size={14} />
          </button>
        </div>
      </div>

      {/* Top-right: Standard Windows Caption Buttons (No right margin, regular 46px width) */}
      <div className="flex h-full items-center titlebar-no-drag">
        <button
          type="button"
          onClick={handleMinimize}
          className="flex h-full w-[46px] items-center justify-center text-foreground/80 transition-colors hover:bg-foreground/10 hover:text-foreground focus:outline-none cursor-pointer"
          title="Minimize"
          aria-label="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <rect y="5" width="10" height="1" />
          </svg>
        </button>

        <button
          type="button"
          onClick={handleMaximize}
          className="flex h-full w-[46px] items-center justify-center text-foreground/80 transition-colors hover:bg-foreground/10 hover:text-foreground focus:outline-none cursor-pointer"
          title={isMaximized ? "Restore Down" : "Maximize"}
          aria-label={isMaximized ? "Restore Down" : "Maximize"}
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <path d="M2.5 0.5H9.5V7.5" />
              <rect x="0.5" y="2.5" width="7" height="7" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
          )}
        </button>

        <button
          type="button"
          onClick={handleClose}
          className="flex h-full w-[46px] items-center justify-center text-foreground/80 transition-colors hover:bg-[#c42b1c] hover:text-white focus:outline-none cursor-pointer"
          title="Close"
          aria-label="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M1 1L9 9M9 1L1 9" />
          </svg>
        </button>
      </div>
    </header>
  );
}
