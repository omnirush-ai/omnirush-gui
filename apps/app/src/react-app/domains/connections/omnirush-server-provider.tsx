/** @jsxImportSource react */
import {
  createContext,
  use,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { OmniRushServerStore } from "./omnirush-server-store";

const OmniRushServerContext = createContext<OmniRushServerStore | null>(null);

export function OmniRushServerProvider(props: {
  store: OmniRushServerStore;
  children: ReactNode;
}) {
  return (
    <OmniRushServerContext.Provider value={props.store}>
      {props.children}
    </OmniRushServerContext.Provider>
  );
}

export function useOmniRushServer() {
  const store = use(OmniRushServerContext);
  if (!store) {
    throw new Error("useOmniRushServer must be used within an OmniRushServerProvider");
  }

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  return store;
}
