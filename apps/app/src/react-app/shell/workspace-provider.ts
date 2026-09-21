import * as React from "react";

import type { OmniRushServerClient } from "@/app/lib/omnirush-server";
import type { Client } from "@/app/types";

type WorkspaceContextValue = {
  client: Client | null;
  opencodeBaseUrl: string;
  omnirushServerClient: OmniRushServerClient | null;
  workspaceId: string;
  selectedWorkspaceRoot: string;
};

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null);

type WorkspaceProviderProps = {
  client: Client | null;
  opencodeBaseUrl?: string;
  omnirushServerClient?: OmniRushServerClient | null;
  workspaceId?: string;
  selectedWorkspaceRoot: string;
  children: React.ReactNode;
};

export function WorkspaceProvider({
  client,
  opencodeBaseUrl = "",
  omnirushServerClient = null,
  workspaceId = "",
  selectedWorkspaceRoot,
  children,
}: WorkspaceProviderProps) {
  const value = React.useMemo(
    () => ({ client, opencodeBaseUrl, omnirushServerClient, workspaceId, selectedWorkspaceRoot }),
    [client, opencodeBaseUrl, omnirushServerClient, workspaceId, selectedWorkspaceRoot],
  );

  return React.createElement(WorkspaceContext.Provider, { value }, children);
}

/** Like useWorkspace, but null when rendered outside a WorkspaceProvider. */
export function useWorkspaceMaybe() {
  return React.use(WorkspaceContext);
}

export function useWorkspace() {
  const context = React.use(WorkspaceContext);

  if (!context) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }

  return context;
}
