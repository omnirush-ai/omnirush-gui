// The Work home composer's reference chips (memory only, like attachment chips), and the inbox an Ask goes through on
// its way to a composer. A Work chat's chips live in its composer state (composer-state-store `refs`), so they follow
// the draft through queueing, failed sends and edits.
import { create } from "zustand";

import { addRef, refKey, type AddRefResult, type WorkRef } from "./refs";

export const workHomeRefOwner = (workspaceId: string) => `work-home:${workspaceId}`;

type AskState = {
  home: Record<string, WorkRef[]>;
  /** The chip that was asked about again (a duplicate): it flashes once. */
  flash: { owner: string; key: string; nonce: number } | null;
  /** The last "added" line for screen readers. */
  announce: string;
  add: (owner: string, ref: WorkRef) => AddRefResult;
  remove: (owner: string, key: string) => void;
  set: (owner: string, refs: WorkRef[]) => void;
  /** Take an owner's chips (they leave it): the Work home handing its chips to the chat it starts. */
  take: (owner: string) => WorkRef[];
  clear: (owner: string) => void;
  markFlash: (owner: string, key: string) => void;
  say: (text: string) => void;
};

const EMPTY: WorkRef[] = [];

export const useAskStore = create<AskState>((set, get) => ({
  home: {},
  flash: null,
  announce: "",
  add: (owner, ref) => {
    const outcome = addRef(get().home[owner] ?? EMPTY, ref);
    if (outcome.result === "added") set((state) => ({ home: { ...state.home, [owner]: outcome.refs } }));
    return outcome;
  },
  remove: (owner, key) => set((state) => {
    const current = state.home[owner];
    if (!current) return state;
    const next = current.filter((ref) => refKey(ref) !== key);
    return next.length === current.length ? state : { home: { ...state.home, [owner]: next } };
  }),
  set: (owner, refs) => set((state) => ({ home: { ...state.home, [owner]: refs } })),
  take: (owner) => {
    const refs = get().home[owner] ?? EMPTY;
    if (refs.length) set((state) => ({ home: { ...state.home, [owner]: EMPTY } }));
    return refs;
  },
  clear: (owner) => set((state) => (state.home[owner]?.length ? { home: { ...state.home, [owner]: EMPTY } } : state)),
  markFlash: (owner, key) => set((state) => ({ flash: { owner, key, nonce: (state.flash?.nonce ?? 0) + 1 } })),
  say: (text) => set({ announce: text }),
}));

export const useHomeRefs = (owner: string | null) => useAskStore((state) => (owner ? state.home[owner] ?? EMPTY : EMPTY));
