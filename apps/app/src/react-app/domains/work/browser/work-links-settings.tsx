/** @jsxImportSource react */
// Settings > Browser: "Open links from Work in" (OmniRush or the person's default browser; the company may set it for
// everyone) and the sites set to always open in another browser. Work accounts in the desktop app only. Both stay on
// this computer.
import { Building2, Lock, Search } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";

import { getBrowserLibraryBridge, useBrowserLibraryAvailable } from "../../browser-logins/use-browser-library";
import { SiteMonogram } from "../../browser-logins/bookmark-tiles";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "../../settings/settings-layout";
import { SettingsSection } from "../../settings/settings-section";
import { ConnectorIcon } from "../brand-icon";
import { useDefaultBrowserName, useElsewhereHosts, useLinksChoice, useWorkLinkPolicy } from "./use-work-links";
import { siteBrand } from "./work-browser";
import { type ElsewhereHost, linksInApp, removeElsewhereHost, writeLinksChoice } from "./work-links";

/** Rows shown before "Show all (n)"; a search box appears once the list is longer. */
export const ELSEWHERE_ROWS_SHOWN = 8;

export function WorkLinksSettings() {
  // Outside the desktop app there is no Work browser: render nothing before touching queries.
  return getBrowserLibraryBridge() === null ? null : <WorkOnly />;
}

function WorkOnly() {
  return useBrowserLibraryAvailable() ? <LinksSection /> : null;
}

function LinksSection() {
  const policy = useWorkLinkPolicy();
  const choice = useLinksChoice();
  const hosts = useElsewhereHosts();
  const browserName = useDefaultBrowserName();
  const inApp = linksInApp(policy, choice);
  const options = [
    { value: "app", label: t("work_links.in_app") },
    { value: "system", label: browserName ?? t("work_links.default_browser") },
  ];
  return (
    <SettingsSection>
      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("work_links.title")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription className="text-[13px] leading-5 text-dls-secondary">{t("work_links.desc")}</LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            {policy.locked ? (
              // The company chose: the choice reads plainly (a greyed-out menu would be hard to read), with who set it below.
              <span className="inline-flex h-9 w-52 items-center gap-2 rounded-4xl border border-border px-3 text-[13px] text-foreground" data-testid="work-links-choice">
                <Lock aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate" title={inApp ? options[0]!.label : options[1]!.label}>{inApp ? options[0]!.label : options[1]!.label}</span>
              </span>
            ) : (
              <Select
                value={inApp ? "app" : "system"}
                items={options}
                onValueChange={(value) => {
                  if (value === "app" || value === "system") writeLinksChoice(value === "app");
                }}
              >
                <SelectTrigger aria-label={t("work_links.title")} className="w-52 text-[13px]" data-testid="work-links-choice">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {options.map((option) => (
                      <SelectItem key={option.value} value={option.value} className="text-[13px]">{option.label}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
        {policy.locked ? (
          <p className="flex items-center gap-2 text-[13px] leading-5 text-dls-secondary" data-testid="work-links-locked">
            <Building2 aria-hidden className="size-4 shrink-0" />
            {policy.orgName ? t("work_links.set_by", { company: policy.orgName }) : t("work_links.set_by_generic")}
          </p>
        ) : null}
        {hosts.length > 0 ? <ElsewhereList hosts={hosts} /> : null}
      </LayoutSectionItem>
    </SettingsSection>
  );
}

function HostMark({ host }: { host: string }) {
  const brand = siteBrand(`https://${host}/`);
  return brand ? <ConnectorIcon id={brand} className="size-[18px]" /> : <SiteMonogram url={`https://${host}/`} />;
}

function ElsewhereList({ hosts }: { hosts: ElsewhereHost[] }) {
  const [all, setAll] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const searchable = hosts.length > ELSEWHERE_ROWS_SHOWN;
  const needle = query.trim().toLowerCase();
  const matched = needle ? hosts.filter((entry) => entry.host.includes(needle)) : hosts;
  const shown = all || needle ? matched : matched.slice(0, ELSEWHERE_ROWS_SHOWN);
  return (
    <div className="flex flex-col gap-2" data-testid="work-links-elsewhere">
      <p className="text-[13px] font-medium text-foreground">{t("work_links.elsewhere_title")}</p>
      {searchable ? (
        <label className="relative block">
          <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("work_links.search")} aria-label={t("work_links.search")} className="ps-9 text-[13px]" data-testid="work-links-search" />
        </label>
      ) : null}
      {shown.length === 0 ? (
        <p className="px-1 py-2 text-[13px] text-dls-secondary">{t("work_links.no_match")}</p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-border">
          {shown.map((entry) => (
            <li key={entry.host} className="flex items-center gap-3 border-b border-border px-4 py-2 last:border-b-0" data-testid="work-links-elsewhere-row">
              <HostMark host={entry.host} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground" title={entry.host}>{entry.host}</span>
              <span className="hidden max-w-[10rem] shrink-0 truncate text-[13px] text-dls-secondary sm:inline" title={entry.browserName ?? undefined}>
                {entry.browserName ?? t("work_links.default_browser")}
              </span>
              <Button variant="ghost" size="sm" className="shrink-0 text-[13px]" aria-label={t("work_links.remove_for", { host: entry.host })} onClick={() => removeElsewhereHost(entry.host)}>
                {t("work_links.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!needle && matched.length > ELSEWHERE_ROWS_SHOWN ? (
        <Button variant="ghost" size="sm" className="self-start text-[13px]" onClick={() => setAll((value) => !value)} data-testid="work-links-show-all">
          {all ? t("work_browser.show_less") : t("work_browser.show_all", { n: matched.length })}
        </Button>
      ) : null}
    </div>
  );
}
