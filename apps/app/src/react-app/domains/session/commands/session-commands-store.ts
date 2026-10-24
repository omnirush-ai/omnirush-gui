import { create } from "zustand";

/**
 * What a mounted chat surface offers the session header and the Changes
 * panel: sending a chat command ("/review", "/fix 1, 3") through the
 * composer's own send path, so it queues, shows and recovers like a typed one.
 */
export type SessionCommandBridge = {
  runCommand: (text: string) => void | Promise<void>;
  /** The chat is working (a turn runs or a send is on its way). */
  busy: boolean;
};

/** The header's undo / redo for the header menu of narrow windows (session-command-controls.tsx). */
export type SessionHeaderActions = {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
};

type SessionCommandsStore = {
  bridges: Record<string, SessionCommandBridge>;
  /** The chat whose Changes panel is open, or null. */
  changesOpenFor: string | null;
  /** The prompt whose turn the open Changes panel shows (a chat's "Changes in this turn"), or null for the last turn. */
  changesTurn: string | null;
  /** The chat whose Status dialog (header menu) is open, or null. */
  statusOpenFor: string | null;
  headerActions: Record<string, SessionHeaderActions>;
  register: (sessionId: string, bridge: SessionCommandBridge) => () => void;
  setHeaderActions: (sessionId: string, actions: SessionHeaderActions | null) => void;
  openChanges: (sessionId: string, turnMessageId?: string | null) => void;
  closeChanges: () => void;
  openStatus: (sessionId: string) => void;
  closeStatus: () => void;
};

export const useSessionCommandsStore = create<SessionCommandsStore>((set, get) => ({
  bridges: {},
  changesOpenFor: null,
  changesTurn: null,
  statusOpenFor: null,
  headerActions: {},
  setHeaderActions: (sessionId, actions) => set((state) => {
    const next = { ...state.headerActions };
    if (actions) next[sessionId] = actions;
    else delete next[sessionId];
    return { headerActions: next };
  }),
  register: (sessionId, bridge) => {
    set((state) => ({ bridges: { ...state.bridges, [sessionId]: bridge } }));
    return () => {
      if (get().bridges[sessionId] !== bridge) return;
      set((state) => {
        const next = { ...state.bridges };
        delete next[sessionId];
        return { bridges: next };
      });
    };
  },
  openChanges: (sessionId, turnMessageId = null) => set({ changesOpenFor: sessionId, changesTurn: turnMessageId }),
  closeChanges: () => set({ changesOpenFor: null, changesTurn: null }),
  openStatus: (sessionId) => set({ statusOpenFor: sessionId }),
  closeStatus: () => set({ statusOpenFor: null }),
}));

export function useSessionCommandBridge(sessionId: string | null | undefined): SessionCommandBridge | null {
  return useSessionCommandsStore((state) => (sessionId ? state.bridges[sessionId] ?? null : null));
}
