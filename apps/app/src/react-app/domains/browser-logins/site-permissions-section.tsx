/** @jsxImportSource react */
// Settings > Browser > Site permissions: the sites the person let use (or blocked from) the camera, microphone or
// notifications in the built-in browser. Eight rows, then Show all, with a search once the list is long. Remove forgets
// a site's choices, so it asks again next time. Work accounts only; hidden while nothing is remembered.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import type { BrowserSitePermission } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";

import { BrandTile } from "../work/brand-icon";
import {
  LayoutSectionItem,
  LayoutSectionItemContent,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
} from "../settings/settings-layout";
import { SettingsSection } from "../settings/settings-section";
import {
  browserSitePermissionsKey,
  getBrowserSitesBridge,
  siteBrand,
  siteHost,
  siteName,
  sitePermissionSummary,
  useSitePermissionList,
} from "./site-permissions";
import { useBrowserLibraryAvailable } from "./use-browser-library";

/** Rows shown before Show all; the search appears once there are more. */
export const SITE_PERMISSION_ROWS = 8;

export function BrowserSitePermissionsSection() {
  // Outside the desktop app there is no browser: render nothing before touching queries.
  return getBrowserSitesBridge() === null ? null : <Section />;
}

function Section() {
  const available = useBrowserLibraryAvailable();
  const list = useSitePermissionList(available);
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const forget = useMutation({
    mutationFn: (origin: string) => getBrowserSitesBridge()!.forget(origin),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: browserSitePermissionsKey }),
    onError: (error) => toast.error(error instanceof Error ? error.message : String(error)),
  });

  const entries = useMemo(() => list.data ?? [], [list.data]);
  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () => (needle ? entries.filter((entry) => entry.origin.toLowerCase().includes(needle)) : entries),
    [entries, needle],
  );

  if (!available || entries.length === 0) return null;

  const searchable = entries.length > SITE_PERMISSION_ROWS;
  const rows = showAll || needle ? matches : matches.slice(0, SITE_PERMISSION_ROWS);

  return (
    <SettingsSection>
      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("site_permissions.section_title")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{t("site_permissions.section_desc")}</LayoutSectionItemDescription>
        </LayoutSectionItemHeader>
        <LayoutSectionItemContent>
          <div className="flex flex-col gap-3" data-testid="site-permissions">
            {searchable ? (
              <div className="relative">
                <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 z-10 size-4 -translate-y-1/2 text-dls-secondary" />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("site_permissions.search")}
                  aria-label={t("site_permissions.search")}
                  className="h-9 ps-9 text-[13px]"
                  data-testid="site-permissions-search"
                />
              </div>
            ) : null}
            {rows.length === 0 ? (
              <p className="rounded-xl border border-border px-4 py-3 text-[13px] text-dls-secondary" data-testid="site-permissions-no-match">
                {t("site_permissions.no_match")}
              </p>
            ) : (
              <ul className="overflow-hidden rounded-xl border border-border" data-testid="site-permissions-list">
                {rows.map((entry) => (
                  <Row key={entry.origin} entry={entry} busy={forget.isPending && forget.variables === entry.origin} onRemove={() => forget.mutate(entry.origin)} />
                ))}
              </ul>
            )}
            {!showAll && !needle && matches.length > SITE_PERMISSION_ROWS ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 self-start px-1.5 text-[13px] text-dls-secondary"
                onClick={() => setShowAll(true)}
                data-testid="site-permissions-show-all"
              >
                {t("site_permissions.show_all", { count: matches.length })}
              </Button>
            ) : null}
          </div>
        </LayoutSectionItemContent>
      </LayoutSectionItem>
    </SettingsSection>
  );
}

function Row({ entry, busy, onRemove }: { entry: BrowserSitePermission; busy: boolean; onRemove: () => void }) {
  const host = siteHost(entry.origin);
  const summary = sitePermissionSummary(entry);
  return (
    <li className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0" data-testid="site-permissions-row">
      <BrandTile id={siteBrand(entry.origin)} name={siteName(entry.origin).toUpperCase()} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium leading-5 text-foreground" title={entry.origin}>{host}</p>
        <p className="truncate text-[13px] leading-5 text-dls-secondary" title={summary}>{summary}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2.5 text-[13px]"
        disabled={busy}
        onClick={onRemove}
        aria-label={t("site_permissions.remove_site", { host })}
      >
        {t("site_permissions.remove")}
      </Button>
    </li>
  );
}
