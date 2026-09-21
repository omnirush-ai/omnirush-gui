/** @jsxImportSource react */
import { createContext, useCallback, use, useMemo, useState, type ReactNode } from "react";
import { isDesktopRuntime } from "../../app/lib/runtime-env";
import { readDesktopDistributionInfo } from "../../app/lib/desktop";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ShellConfig = {
  /** Display name shown in the title bar, sidebar, and welcome page. */
  appName: string;
  /** Show live connection status inside the sidebar account menu. */
  statusBar: boolean;
  /** Show the left sidebar with workspace/session list. */
  sidebar: boolean;
  /** Show the Docs entry in the account menu. */
  docsButton: boolean;
  /** Show the Feedback entry in the account menu. */
  feedbackButton: boolean;
  /** Show the Cloud sign-in button when not signed in. */
  cloudSignin: boolean;
  /** Show the welcome/onboarding page for new users. */
  welcomePage: boolean;
  /** Show starter task cards in empty sessions. */
  starterCards: boolean;
  /** Show the model picker / model change UI. */
  modelPicker: boolean;
  /** Show the built-in browser panel. */
  browser: boolean;
  /** Show the "Add workspace" button. */
  addWorkspace: boolean;
  /** Show the notification bell in the header. */
  notifications: boolean;
};

/* ------------------------------------------------------------------ */
/*  Defaults                                                           */
/* ------------------------------------------------------------------ */

export const DEFAULT_SHELL_CONFIG: ShellConfig = {
  appName: "omnirush.ai",
  statusBar: true,
  sidebar: true,
  docsButton: true,
  feedbackButton: true,
  cloudSignin: true,
  welcomePage: true,
  starterCards: true,
  modelPicker: true,
  browser: true,
  addWorkspace: true,
  notifications: true,
};

/* ------------------------------------------------------------------ */
/*  Persistence                                                        */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = "omnirush.shell-config";

function effectiveShellConfig(config: ShellConfig): ShellConfig {
  if (isDesktopRuntime() && readDesktopDistributionInfo().flavor === "public") {
    return { ...config, cloudSignin: false };
  }
  return config;
}

function readShellConfig(): ShellConfig {
  if (typeof window === "undefined") return DEFAULT_SHELL_CONFIG;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return effectiveShellConfig(DEFAULT_SHELL_CONFIG);
    const parsed = JSON.parse(raw);
    return effectiveShellConfig({ ...DEFAULT_SHELL_CONFIG, ...parsed });
  } catch {
    return effectiveShellConfig(DEFAULT_SHELL_CONFIG);
  }
}

function writeShellConfig(config: ShellConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage errors.
  }
}

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

type ShellConfigContextValue = {
  config: ShellConfig;
  update: (patch: Partial<ShellConfig>) => void;
  reset: () => void;
};

const ShellConfigContext = createContext<ShellConfigContextValue | undefined>(undefined);

export function ShellConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ShellConfig>(readShellConfig);

  const update = useCallback((patch: Partial<ShellConfig>) => {
    setConfig((prev) => {
      const next = effectiveShellConfig({ ...prev, ...patch });
      writeShellConfig(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    const next = effectiveShellConfig(DEFAULT_SHELL_CONFIG);
    setConfig(next);
    writeShellConfig(next);
  }, []);

  const value = useMemo<ShellConfigContextValue>(
    () => ({ config, update, reset }),
    [config, update, reset],
  );

  return (
    <ShellConfigContext.Provider value={value}>
      {children}
    </ShellConfigContext.Provider>
  );
}

export function useShellConfig(): ShellConfigContextValue {
  const ctx = use(ShellConfigContext);
  if (!ctx) {
    throw new Error("useShellConfig must be used within a ShellConfigProvider");
  }
  return ctx;
}
