// Shell panel open-state (command palette, session search, terminal) plus the
// global keyboard shortcuts that toggle them. Extracted verbatim from
// session-route.tsx.
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { usePlatform } from "../kernel/platform";
import {
  getSessionNumberShortcutIntent,
  hasSessionNumberShortcutOwner,
  isSessionNumberModifierKey,
  isSessionNumberModifierPressed,
  nextSessionNumberModifierHeld,
  readVisibleSessionNumberShortcutTargets,
  resolveSessionNumberShortcutOs,
  sameSessionNumberShortcutTargets,
  type SessionNumberShortcutOs,
  type SessionNumberShortcutTarget,
  type SessionNumberShortcutTransition,
} from "./session-number-shortcuts";
import {
  getThinkingModeShortcutDirection,
  resolveThinkingModeShortcutOs,
  type ThinkingModeShortcutDirection,
} from "./thinking-mode-shortcut";
import { isFavoriteModelShortcut } from "./favorite-model-shortcut";
import { useTerminalTabsStore } from "../domains/session/terminal/terminal-tabs-store";
import { useEditorStore } from "../domains/session/editor/editor-store";
import { isElectronRuntime } from "../../app/utils";

export type UseShellShortcutsInput = {
  canCreateTask: boolean;
  workspaceId: string;
  onCreateTask: (workspaceId: string) => void | Promise<void>;
  onNextSessionTab?: () => void;
  onPrevSessionTab?: () => void;
  onCycleThinkingMode?: (direction: ThinkingModeShortcutDirection) => void;
  onCycleFavoriteModel?: () => void;
  /** False while Cmd/Ctrl+K belongs to someone else (Work: its Search). */
  commandPaletteShortcut?: boolean;
};

export function useCommandPaletteShortcut(enabled = true) {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const handleCommandPaletteShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!enabled) return;
    const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod || event.shiftKey || event.altKey || event.key?.toLowerCase() !== "k") return;
    event.preventDefault();
    setCommandPaletteOpen((value) => !value);
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleCommandPaletteShortcut(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return { commandPaletteOpen, setCommandPaletteOpen };
}

/** Ctrl+` (the Backquote key, no Shift): show and focus the terminal. */
export function isToggleTerminalShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.code === "Backquote";
}

/** Ctrl+Shift+` (the Backquote key, whatever the layout prints on it): a new terminal tab. */
export function isNewTerminalShortcut(event: Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "code">) {
  return event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === "Backquote";
}

export function useShellShortcuts(input: UseShellShortcutsInput) {
  const platform = usePlatform();
  const {
    canCreateTask,
    workspaceId,
    onCreateTask,
    onNextSessionTab,
    onPrevSessionTab,
    onCycleThinkingMode,
    onCycleFavoriteModel,
  } = input;
  const { commandPaletteOpen, setCommandPaletteOpen } = useCommandPaletteShortcut(input.commandPaletteShortcut !== false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [sessionNumberModifierHeld, setSessionNumberModifierHeld] = useState(false);
  const [sessionNumberTargets, setSessionNumberTargets] = useState<SessionNumberShortcutTarget[]>([]);
  const sessionNumberCancelledRef = useRef(false);
  const sessionNumberModifierHeldRef = useRef(false);
  const sessionNumberOs: SessionNumberShortcutOs = resolveSessionNumberShortcutOs(
    platform.os,
    typeof navigator === "undefined" ? "" : navigator.platform,
  );
  const thinkingModeShortcutOs = resolveThinkingModeShortcutOs(
    platform.os,
    typeof navigator === "undefined" ? "" : navigator.platform,
  );

  const clearSessionNumberShortcuts = useEffectEvent((
    cancelUntilRelease: boolean,
    transition: SessionNumberShortcutTransition,
  ) => {
    sessionNumberCancelledRef.current = cancelUntilRelease;
    const modifierHeld = nextSessionNumberModifierHeld(transition);
    sessionNumberModifierHeldRef.current = modifierHeld;
    setSessionNumberModifierHeld(modifierHeld);
    setSessionNumberTargets((current) => current.length === 0 ? current : []);
  });

  const refreshSessionNumberShortcuts = useEffectEvent(() => {
    if (hasSessionNumberShortcutOwner(document)) {
      clearSessionNumberShortcuts(true, "owner-change");
      return [];
    }
    const targets = readVisibleSessionNumberShortcutTargets(document);
    sessionNumberModifierHeldRef.current = true;
    setSessionNumberModifierHeld(true);
    setSessionNumberTargets((current) => (
      sameSessionNumberShortcutTargets(current, targets) ? current : targets
    ));
    return targets;
  });

  // Global shortcuts:
  //   Cmd/Ctrl+N        -> new task in selected workspace
  //   Cmd/Ctrl+K        -> toggle command palette
  //   Cmd/Ctrl+J        -> toggle terminal panel (matches VS Code)
  //   Cmd/Ctrl+P        -> editor: go to file (opens the editor)
  //   Cmd/Ctrl+Shift+E  -> open the IDE layout (files view)
  //   Cmd/Ctrl+Shift+Y  -> switch layout: Chat / IDE
  //   Cmd/Ctrl+Shift+H  -> IDE layout: show / hide the chat
  //   Ctrl+Shift+`      -> new terminal tab (matches VS Code; Ctrl on macOS too)
  //   Cmd/Ctrl+F        -> find in current conversation (handled by session surface)
  //   Cmd/Ctrl+Shift+F  -> search every session (titles + messages); in the IDE layout: search in files
  //   Cmd/Ctrl+Shift+P  -> command palette (as Cmd/Ctrl+K)
  //   Cmd+Shift+M       -> IDE layout, macOS: Problems
  //   Cmd/Ctrl+T        -> next session tab
  //   Cmd/Ctrl+Shift+T  -> previous session tab
  //   Ctrl+T / Ctrl+Shift+T (macOS) -> next / previous thinking mode
  //   Ctrl+Alt+T / Ctrl+Alt+Shift+T (Windows/Linux) -> next / previous thinking mode
  //   Ctrl+Shift+M      -> next favorite model
  //   Cmd/Ctrl+1–9      -> matching visible sidebar session
  const handleGlobalShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (isFavoriteModelShortcut(event)) {
      event.preventDefault();
      if (!event.repeat) onCycleFavoriteModel?.();
      return;
    }
    if (isNewTerminalShortcut(event) && platform.capabilities.terminal) {
      event.preventDefault();
      if (event.repeat) return;
      useTerminalTabsStore.getState().requestNewTab();
      setTerminalOpen(true);
      return;
    }
    // Ctrl+` (every platform, as in VS Code): show the terminal and focus it; again from inside it hides it.
    if (isToggleTerminalShortcut(event) && platform.capabilities.terminal) {
      event.preventDefault();
      if (event.repeat) return;
      const inTerminal = Boolean((document.activeElement as HTMLElement | null)?.closest?.(".xterm"));
      if (terminalOpen && inTerminal) {
        setTerminalOpen(false);
        return;
      }
      setTerminalOpen(true);
      useEditorStore.getState().setBottomTab("terminal");
      const focus = (tries: number) => window.requestAnimationFrame(() => {
        const input = document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
        if (input) input.focus();
        else if (tries > 0) focus(tries - 1);
      });
      focus(20);
      return;
    }
    const thinkingModeDirection = getThinkingModeShortcutDirection(event, thinkingModeShortcutOs);
    if (thinkingModeDirection) {
      event.preventDefault();
      if (!event.repeat) onCycleThinkingMode?.(thinkingModeDirection);
      return;
    }
    const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod) return;
    // In the IDE layout these keys work as in VS Code: Cmd/Ctrl+Shift+F searches the files, Cmd/Ctrl+Shift+P opens the palette,
    // Cmd+Shift+M (macOS) opens Problems. In the Chat layout Cmd/Ctrl+Shift+F stays the session search.
    const ideLayout = typeof document !== "undefined" && Boolean(document.querySelector("[data-editor-layout='ide']"));
    const editorCommand = (command: string) => window.dispatchEvent(new CustomEvent("omnirush:editor-command", { detail: command }));
    if (event.shiftKey && !event.altKey && event.key?.toLowerCase() === "f") {
      event.preventDefault();
      if (ideLayout) editorCommand("search");
      else setSessionSearchOpen((value) => !value);
      return;
    }
    // Cmd/Ctrl+\ (the Backslash key wherever the layout puts it): split the editor, IDE layout only.
    if (ideLayout && !event.shiftKey && !event.altKey && event.code === "Backslash") {
      event.preventDefault();
      editorCommand("split");
      return;
    }
    if (event.shiftKey && !event.altKey && event.key?.toLowerCase() === "p") {
      event.preventDefault();
      setCommandPaletteOpen(true);
      return;
    }
    if (ideLayout && isMac && event.shiftKey && !event.altKey && event.key?.toLowerCase() === "m") {
      event.preventDefault();
      editorCommand("problems");
      return;
    }
    if (event.shiftKey && !event.altKey && event.key?.toLowerCase() === "e") {
      event.preventDefault();
      if (!event.repeat) useEditorStore.getState().requestToggle();
      return;
    }
    if (event.shiftKey && !event.altKey && event.key?.toLowerCase() === "y" && isElectronRuntime()) {
      event.preventDefault();
      if (!event.repeat) useEditorStore.getState().requestModeToggle();
      return;
    }
    if (event.shiftKey && !event.altKey && event.key?.toLowerCase() === "h" && isElectronRuntime()) {
      event.preventDefault();
      if (!event.repeat) useEditorStore.getState().requestChatToggle();
      return;
    }
    if (event.shiftKey && !event.altKey && event.key?.toLowerCase() === "t") {
      event.preventDefault();
      onPrevSessionTab?.();
      return;
    }
    if (event.shiftKey || event.altKey) return;

    const target = event.target as HTMLElement | null;
    const inEditable =
      !!target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);

    const key = event.key?.toLowerCase();
    if (key === "n" && !inEditable) {
      event.preventDefault();
      if (canCreateTask && workspaceId) {
        void onCreateTask(workspaceId);
      }
      return;
    }
    // In the terminal Ctrl+P is the shell's (previous command); Cmd+P on macOS still opens quick open.
    const inTerminal = Boolean(target?.closest?.(".xterm"));
    if (key === "p" && isElectronRuntime() && !(inTerminal && !isMac)) {
      // Quick open: shows the editor (session-page) with its file finder.
      event.preventDefault();
      const editor = useEditorStore.getState();
      editor.setQuickOpen(true);
      editor.requestShow();
      return;
    }
    if (key === "j" && platform.capabilities.terminal) {
      event.preventDefault();
      // IDE layout: the whole bottom panel (Problems and Terminal), back on the tab it last showed.
      if (document.querySelector("[data-editor-layout='ide']")) {
        const editor = useEditorStore.getState();
        if (terminalOpen || editor.problemsOpen) {
          editor.setProblemsOpen(false);
          setTerminalOpen(false);
        } else if (editor.bottomTab === "problems") editor.setProblemsOpen(true);
        else setTerminalOpen(true);
        return;
      }
      setTerminalOpen((value) => !value);
      return;
    }
    if (key === "t") {
      event.preventDefault();
      onNextSessionTab?.();
      return;
    }
  });

  const handleSessionNumberKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      sessionNumberModifierHeldRef.current &&
      !isSessionNumberModifierPressed(event, sessionNumberOs)
    ) {
      clearSessionNumberShortcuts(false, "modifier-mismatch");
    }
    const intent = getSessionNumberShortcutIntent(event, sessionNumberOs, {
      ownerActive: hasSessionNumberShortcutOwner(document),
      cancelled: sessionNumberCancelledRef.current,
    });
    if (intent.type === "ignore") {
      if (isSessionNumberModifierKey(event.key, sessionNumberOs)) {
        clearSessionNumberShortcuts(true, "owner-change");
      }
      return;
    }
    if (intent.type === "hold") {
      sessionNumberCancelledRef.current = false;
      refreshSessionNumberShortcuts();
      return;
    }

    const targets = refreshSessionNumberShortcuts();
    const target = targets[intent.digit - 1];
    if (!target) return;
    event.preventDefault();
    if (!event.repeat) target.button.click();
  });

  const handleSessionNumberKeyUp = useEffectEvent((event: KeyboardEvent) => {
    if (!isSessionNumberModifierKey(event.key, sessionNumberOs)) return;
    clearSessionNumberShortcuts(false, "modifier-up");
  });

  const handleSessionNumberMouseMove = useEffectEvent((event: MouseEvent) => {
    if (
      sessionNumberModifierHeldRef.current &&
      !isSessionNumberModifierPressed(event, sessionNumberOs)
    ) {
      clearSessionNumberShortcuts(false, "modifier-mismatch");
    }
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleGlobalShortcut(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => handleSessionNumberKeyDown(event);
    const keyUp = (event: KeyboardEvent) => handleSessionNumberKeyUp(event);
    const mouseMove = (event: MouseEvent) => handleSessionNumberMouseMove(event);
    const loseOwnership = () => clearSessionNumberShortcuts(true, "owner-change");
    const blur = () => clearSessionNumberShortcuts(true, "blur");
    const focus = () => clearSessionNumberShortcuts(true, "focus");
    const visibilityChange = () => {
      if (document.visibilityState !== "visible") {
        clearSessionNumberShortcuts(true, "visibility-hidden");
      }
    };
    const focusIn = () => {
      if (hasSessionNumberShortcutOwner(document)) {
        loseOwnership();
      }
    };
    const observer = new MutationObserver(() => {
      if (!sessionNumberModifierHeldRef.current) return;
      if (hasSessionNumberShortcutOwner(document)) {
        loseOwnership();
      } else {
        refreshSessionNumberShortcuts();
      }
    });

    // Capture first so text fields and open select/menu popovers cannot consume
    // the global session jump before the shell sees it.
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("mousemove", mouseMove, { passive: true });
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibilityChange);
    document.addEventListener("focusin", focusIn);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    return () => {
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("mousemove", mouseMove);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibilityChange);
      document.removeEventListener("focusin", focusIn);
      sessionNumberModifierHeldRef.current = false;
      observer.disconnect();
    };
  }, []);

  return {
    commandPaletteOpen,
    setCommandPaletteOpen,
    sessionSearchOpen,
    setSessionSearchOpen,
    terminalOpen,
    setTerminalOpen,
    sessionNumberShortcuts: {
      modifierHeld: sessionNumberModifierHeld,
      os: sessionNumberOs,
      targets: sessionNumberTargets,
    },
  };
}
