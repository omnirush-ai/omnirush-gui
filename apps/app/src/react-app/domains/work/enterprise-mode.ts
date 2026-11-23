// Enterprise mode: an OmniRush Work company account (`enterprise` in the Work state, from the server's capabilities).
// Work first, Code only when staff turned it on for the company, and none of the consumer app's extras (rewards, events,
// placements, usage meter, what's new). Every other account never has the block and sees the app as before.
// Not the inherited Den "enterprise" build (electron-builder.enterprise.yml, cloud/enterprise-activation-gate.tsx).
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { OmniRushWorkEnterprise } from "@/app/lib/omnirush-server";

import { useWorkState, WORK_PRESET, workStateKey, type WorkClient } from "./work-mode";

export type EnterpriseMode = {
  /** A company account: hide the consumer extras. */
  on: boolean;
  /** The company is active: Work works (otherwise the waiting screen). */
  active: boolean;
  status: OmniRushWorkEnterprise["status"] | null;
  /** Staff turned Code on for the company. */
  code: boolean;
  role: OmniRushWorkEnterprise["role"];
  orgName: string | null;
  portalUrl: string | null;
  capture: OmniRushWorkEnterprise["capture"];
};

export const CONSUMER: EnterpriseMode = { on: false, active: false, status: null, code: true, role: null, orgName: null, portalUrl: null, capture: { code: true, chat: true } };

export function enterpriseMode(block: OmniRushWorkEnterprise | null | undefined): EnterpriseMode {
  if (!block) return CONSUMER;
  return {
    on: true,
    active: block.status === "active",
    status: block.status,
    code: block.code === true && block.status === "active",
    role: block.role ?? null,
    orgName: block.org?.name ?? null,
    portalUrl: block.portal_url ?? null,
    capture: block.capture,
  };
}

/** The last enterprise block this app saw, so a company account starts without a flash of the consumer extras. */
export const useEnterpriseStore = create<{ block: OmniRushWorkEnterprise | null; setBlock: (block: OmniRushWorkEnterprise | null) => void }>()(
  persist((set) => ({ block: null, setBlock: (block) => set({ block }) }), {
    name: "omnirush.workEnterprise",
    storage: createJSONStorage(() => localStorage),
  }),
);

/** Enterprise mode for components that have no Work client (sidebar footer, rewards, events): the last state seen. */
export function useEnterpriseFlags(): EnterpriseMode {
  const block = useEnterpriseStore((state) => state.block);
  return useMemo(() => enterpriseMode(block), [block]);
}

/**
 * Enterprise mode from the Work state, kept in the app-wide store. A company account also reads the state again when
 * the window comes to the front, so a Code switch staff changed shows without waiting for the 5-minute cache.
 */
export function useEnterpriseMode(client: WorkClient | null): EnterpriseMode {
  const queryClient = useQueryClient();
  const state = useWorkState(client);
  const saved = useEnterpriseStore((store) => store.block);
  const setBlock = useEnterpriseStore((store) => store.setBlock);
  const answered = state.data !== undefined;
  const block = answered ? state.data?.enterprise ?? null : saved;
  useEffect(() => {
    if (!answered) return;
    const next = state.data?.enterprise ?? null;
    if (JSON.stringify(next) !== JSON.stringify(useEnterpriseStore.getState().block)) setBlock(next);
  }, [answered, setBlock, state.data]);
  const on = Boolean(block);
  useEffect(() => {
    if (!client || !on) return;
    const refresh = () => {
      void client.getWorkState({ fresh: true })
        .then((next) => queryClient.setQueryData(workStateKey(client), next))
        .catch(() => undefined);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [client, on, queryClient]);
  return useMemo(() => enterpriseMode(block), [block]);
}

/** Paths a company account without Code is sent away from (to the Work home): every Code surface. Settings and Work
 *  stay. */
const CODE_PATH = /^\/(?:session|workspace|automations|apps|dashboard|extensions)(?:\/|$)/;
const SETTINGS_PATH = /^\/(?:settings|workspace\/[^/]+\/settings)(?:\/|$)/;

/**
 * Where a company account goes from `pathname`: the Work home from any Code surface while Code is off; null to stay.
 * `workspacePreset` is the route workspace's preset: a Work chat (`/workspace/<the Work folder>/session/…`) stays, and
 * nothing moves while the workspaces are still loading (undefined).
 */
export function enterpriseRedirect(mode: EnterpriseMode, pathname: string, workspacePreset?: string | null): string | null {
  if (!mode.on || !mode.active || mode.code) return null;
  if (SETTINGS_PATH.test(pathname) || /^\/work(?:\/|$)/.test(pathname)) return null;
  if (/^\/workspace\/[^/]+/.test(pathname)) return workspacePreset === undefined || workspacePreset === WORK_PRESET ? null : "/work";
  return CODE_PATH.test(pathname) || pathname === "/" ? "/work" : null;
}
