import * as React from "react";
import type { OmniRushServerClient } from "@/app/lib/omnirush-server";

import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";

export type OpenTargetOptions = {
  auto?: boolean;
  external?: boolean;
  reveal?: boolean;
};

type OpenTargetHandler = (target: OpenTarget, options?: OpenTargetOptions) => void;

type OpenTargetContextValue = {
  client?: OmniRushServerClient;
  workspaceId?: string;
  workspaceRoot?: string;
  openTargets: OpenTarget[];
  onOpenTarget: OpenTargetHandler | undefined;
};

type OpenTargetProviderProps = {
  children: React.ReactNode;
  client?: OmniRushServerClient;
  workspaceId?: string;
  workspaceRoot?: string;
  openTargets?: OpenTarget[] | undefined;
  onOpenTarget?: OpenTargetHandler | undefined;
};

const EMPTY_OPEN_TARGETS: OpenTarget[] = [];

const OpenTargetContext = React.createContext<OpenTargetContextValue>({
  openTargets: EMPTY_OPEN_TARGETS,
  onOpenTarget: undefined,
});

export function OpenTargetProvider({
  children,
  client,
  workspaceId,
  workspaceRoot,
  openTargets = EMPTY_OPEN_TARGETS,
  onOpenTarget,
}: OpenTargetProviderProps) {
  const value = React.useMemo(
    () => ({
      client,
      workspaceId,
      workspaceRoot,
      openTargets,
      onOpenTarget,
    }),
    [client, workspaceId, workspaceRoot, openTargets, onOpenTarget],
  );

  return React.createElement(OpenTargetContext.Provider, { value }, children);
}

export function useOpenTargets() {
  return React.useContext(OpenTargetContext);
}
