/** @jsxImportSource react */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import type { OmniRushServerClient, OmniRushWebSearchState } from "@/app/lib/omnirush-server";
import { useDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";

import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "./settings-layout";

export type WebSearchClient = Pick<OmniRushServerClient, "getWebSearch" | "setWebSearch"> & { baseUrl?: string };

export const WEB_SEARCH_TITLE = "Web search";
export const WEB_SEARCH_HELP = "Lets the agent search the web. Off: the agent gets no web search tool from the next message on. It can still open a web page you give it.";
export const WEB_SEARCH_SERVER_OFF = "Web search is turned off for your account.";

/**
 * Settings > Preferences > Model: "Web search" (on by default). The server's switch wins: while it
 * is off the switch shows off and cannot be turned on (GET/PUT /omnirush/web-search).
 */
export function WebSearchSetting(props: { client: WebSearchClient | null; busy?: boolean }) {
  const policyLocked = useDesktopRestriction("allowControlSettings");
  const queryClient = useQueryClient();
  const key = ["omnirush-web-search", props.client?.baseUrl?.trim() || "default"];
  const query = useQuery({
    queryKey: key,
    queryFn: () => props.client!.getWebSearch(),
    enabled: Boolean(props.client),
  });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => props.client!.setWebSearch(enabled),
    onSuccess: (state) => queryClient.setQueryData<OmniRushWebSearchState>(key, { enabled: state.enabled, user: state.user, serverAllows: state.serverAllows }),
    onError: (reason: unknown) => toast.error(reason instanceof Error ? reason.message : "The web search setting could not be saved."),
  });
  if (!props.client) return null;
  const state = query.data;
  const serverOff = state ? !state.serverAllows : false;
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{WEB_SEARCH_TITLE}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>
          {WEB_SEARCH_HELP}
          {serverOff ? <span className="mt-1 block" data-testid="settings-web-search-status">{WEB_SEARCH_SERVER_OFF}</span> : null}
        </LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <Switch
            aria-label={WEB_SEARCH_TITLE}
            data-testid="settings-web-search"
            checked={state ? state.enabled : true}
            disabled={Boolean(props.busy) || policyLocked || !state || serverOff || mutation.isPending}
            onCheckedChange={(checked: boolean) => mutation.mutate(checked)}
          />
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
    </LayoutSectionItem>
  );
}
