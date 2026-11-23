/** @jsxImportSource react */
// The pieces of Work's first run (work-onboarding.tsx puts them together): the step bar, team size chips, the tool
// picker (one "Search or add a tool" field), the connect list, the invite field and the done screen. Pure helpers
// (the step order, e-mail parsing, name guesses) are exported for the tests.
import { ArrowRight, Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { BrandTile, LetterMark } from "./brand-icon";
import {
  addCustomTool, customToolName, CUSTOM_TOOLS_MAX, matchTool, searchTools, sizeLabel,
  type CatalogGroup, type CatalogTool,
} from "./catalog";

export type OnboardingStep = "company" | "welcome" | "tools" | "connect" | "invite" | "done";

/** The steps a person goes through. A new company: company, tools, connect, invite. A company made on the web (it has
 *  its tools already): connect, then invite for owners and admins. An invited member: welcome, connect. Done ends all. */
export function onboardingSteps(input: { hasOrg: boolean; role: "owner" | "admin" | "member" | string | null; changeTools?: boolean }): OnboardingStep[] {
  if (!input.hasOrg) return ["company", "tools", "connect", "invite", "done"];
  const manager = input.role === "owner" || input.role === "admin";
  if (!manager) return ["welcome", "connect", "done"];
  return [...(input.changeTools ? (["tools"] as const) : []), "connect", "invite", "done"];
}

/** "acme-freight.com" -> "Acme Freight": a first guess at the company name from its domain. */
export function companyFromDomain(domain: string): string {
  const head = domain.trim().toLowerCase().replace(/^www\./, "").split(".")[0] ?? "";
  return head.split(/[-_]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

const EMAIL = /^[^\s@,;<>]{1,64}@[^\s@,;<>]{1,189}\.[^\s@,;<>]{2,}$/;

/** The addresses in what was typed or pasted ("Ana <ana@acme.com>, ben@acme.com"): lower case, each once; and what
 *  could not be read as an address. */
export function parseEmails(typed: string): { emails: string[]; rejected: string[] } {
  const emails: string[] = [];
  const rejected: string[] = [];
  for (const part of typed.split(/[\s,;]+/)) {
    const bare = part.replace(/^[<"'(]+|[>"')]+$/g, "").trim().toLowerCase();
    if (!bare) continue;
    if (EMAIL.test(bare)) { if (!emails.includes(bare)) emails.push(bare); }
    else if (bare.includes("@")) rejected.push(bare);
  }
  return { emails, rejected };
}

/** The four thin segments over every step, the ones done and current filled. */
export function StepBar(props: { total: number; current: number; label?: string }) {
  return (
    <div className="flex items-center gap-3" data-testid="work-onboarding-progress" data-current={props.current + 1} data-total={props.total}>
      <ol className="flex flex-1 items-center gap-1.5" aria-label={t("work.setup.step_of", { n: props.current + 1, total: props.total })}>
        {Array.from({ length: props.total }, (_, index) => (
          <li
            key={index}
            aria-current={index === props.current ? "step" : undefined}
            className={cn(
              "h-1 flex-1 rounded-full motion-safe:transition-colors motion-safe:duration-200",
              index <= props.current ? "bg-foreground/80" : "bg-foreground/10",
            )}
          />
        ))}
      </ol>
      <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{props.label ?? t("work.setup.step_of", { n: props.current + 1, total: props.total })}</span>
    </div>
  );
}

/** A step's title block; the title takes focus when the step opens (screen readers hear the new step). */
export function StepHeading(props: { title: string; body?: string; titleRef?: React.Ref<HTMLHeadingElement> }) {
  return (
    <div className="space-y-1.5">
      <h1 ref={props.titleRef} tabIndex={-1} className="text-balance text-[22px] font-semibold leading-[28px] tracking-[-0.02em] outline-none">{props.title}</h1>
      {props.body ? <p className="text-[13px] leading-5 text-muted-foreground">{props.body}</p> : null}
    </div>
  );
}

/** Team size: compact chips on one row, a radio group (arrow keys move, the label sits above). */
export function SizeChips(props: { sizes: readonly string[]; value: string | null; onChange: (value: string | null) => void; labelId: string; disabled?: boolean }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = props.value ? props.sizes.indexOf(props.value) : -1;
  const move = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + props.sizes.length) % props.sizes.length;
    props.onChange(props.sizes[next] ?? null);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-labelledby={props.labelId} className="flex flex-wrap gap-1" data-testid="work-onboarding-sizes">
      {props.sizes.map((size, index) => {
        const selected = props.value === size;
        return (
          <button
            key={size}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-pressed={selected}
            tabIndex={selected || (at === -1 && index === 0) ? 0 : -1}
            disabled={props.disabled}
            data-size={size}
            onClick={() => props.onChange(selected ? null : size)}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              "h-7 flex-auto whitespace-nowrap rounded-full border px-2 text-[12px] tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
              selected ? "border-foreground bg-foreground text-background" : "border-border text-foreground hover:border-foreground/30 hover:bg-muted/60",
            )}
          >
            {sizeLabel(size)}
          </button>
        );
      })}
    </div>
  );
}

/** One tool to pick: the brand tile, the name, pressed when picked. */
function ToolChip(props: { tool: CatalogTool; selected: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      data-testid={`work-onboarding-tool-${props.tool.id}`}
      onClick={props.onToggle}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-full border ps-1 pe-2.5 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        props.selected ? "border-foreground/50 bg-foreground/[0.06] text-foreground" : "border-border text-foreground/90 hover:border-foreground/30 hover:bg-muted/60",
      )}
    >
      <BrandTile id={props.tool.id} size="chip" className="rounded-full" />
      <span className="whitespace-nowrap">{props.tool.label}</span>
      {props.selected ? <Check aria-hidden className="size-3.5 text-foreground/70" /> : null}
    </button>
  );
}

/**
 * The tool picker: the catalog by group, one field to search it or add a tool it does not have ("Add "Basecamp"" is the
 * last row when nothing matches). Enter picks an exact match, or adds the typed name; custom tools show as chips with a
 * remove button.
 */
export function ToolPicker(props: {
  groups: CatalogGroup[];
  selected: string[];
  custom: string[];
  onToggle: (id: string) => void;
  onCustom: (custom: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const inputId = useId();
  const typed = query.trim();
  const exact = typed ? matchTool(props.groups, typed) : null;
  const found = typed ? searchTools(props.groups, typed) : [];
  const customName = typed && !exact ? customToolName(typed) : null;
  const already = customName ? props.custom.some((name) => name.toLowerCase() === customName.toLowerCase()) : false;
  const canAdd = Boolean(customName) && !already && props.custom.length < CUSTOM_TOOLS_MAX;
  const add = () => {
    if (!customName) return;
    props.onCustom(addCustomTool(props.custom, customName));
    setQuery("");
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); return; }
    if (event.key !== "Enter" || !typed) return;
    // Enter in the field picks or adds; it never submits the step.
    event.preventDefault();
    event.stopPropagation();
    if (exact) {
      if (!props.selected.includes(exact.id)) props.onToggle(exact.id);
      setQuery("");
    } else if (found.length === 1 && found[0]) {
      if (!props.selected.includes(found[0].id)) props.onToggle(found[0].id);
      setQuery("");
    } else if (canAdd) add();
  };
  const groups = typed
    ? props.groups.map((group) => ({ ...group, tools: group.tools.filter((row) => found.includes(row)) })).filter((group) => group.tools.length)
    : props.groups;
  return (
    <div className="flex flex-col gap-4" data-testid="work-onboarding-tools">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={inputId}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKey}
          maxLength={60}
          placeholder={t("work.setup.search_or_add")}
          aria-label={t("work.setup.search_or_add")}
          className="ps-9"
          data-testid="work-onboarding-tool-search"
          autoComplete="off"
        />
      </div>
      <div className="@container flex flex-col gap-2.5">
        {groups.map((group) => (
          <div key={group.id} className="grid gap-1.5 @[600px]:grid-cols-[144px_1fr] @[600px]:gap-x-3" data-tool-group={group.id}>
            <span className="text-[12px] font-medium leading-4 text-muted-foreground @[600px]:whitespace-nowrap @[600px]:pt-1.5">{group.label}</span>
            <div className="flex flex-wrap gap-1.5">
              {group.tools.map((row) => <ToolChip key={row.id} tool={row} selected={props.selected.includes(row.id)} onToggle={() => props.onToggle(row.id)} />)}
            </div>
          </div>
        ))}
        {typed && !exact ? (
          canAdd ? (
            <button
              type="button"
              onClick={add}
              data-testid="work-onboarding-add-custom"
              className="flex h-9 items-center gap-2 self-start rounded-lg border border-dashed border-border px-3 text-[13px] text-foreground outline-none transition-colors hover:border-foreground/30 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus aria-hidden className="size-3.5 text-muted-foreground" />
              {t("work.setup.add_custom", { name: customName ?? "" })}
              <kbd className="ms-1 rounded border border-border px-1 text-[11px] text-muted-foreground">↵</kbd>
            </button>
          ) : (
            <p className="text-[12px] text-muted-foreground" data-testid="work-onboarding-custom-note">
              {already ? t("work.setup.custom_already") : props.custom.length >= CUSTOM_TOOLS_MAX ? t("work.setup.custom_full", { n: CUSTOM_TOOLS_MAX }) : t("work.setup.custom_rule")}
            </p>
          )
        ) : null}
      </div>
      {props.custom.length ? (
        <div className="@container" data-testid="work-onboarding-custom">
         <div className="grid gap-1.5 @[600px]:grid-cols-[144px_1fr] @[600px]:gap-x-3">
          <span className="text-[12px] font-medium leading-4 text-muted-foreground @[600px]:whitespace-nowrap @[600px]:pt-1.5">{t("work.setup.your_other_tools")}</span>
          <div className="flex flex-wrap gap-1.5">
            {props.custom.map((name) => (
              <span key={name} className="flex h-7 items-center gap-1.5 rounded-full border border-foreground/50 bg-foreground/[0.06] ps-1 pe-0.5 text-[13px]" data-custom-tool={name}>
                <span className="flex size-5 items-center justify-center rounded-full border border-border bg-background" aria-hidden><LetterMark letter={name} className="size-3" /></span>
                <span className="whitespace-nowrap">{name}</span>
                <button
                  type="button"
                  aria-label={t("work.setup.remove_tool", { name })}
                  onClick={() => props.onCustom(props.custom.filter((item) => item !== name))}
                  className="flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </span>
            ))}
          </div>
         </div>
        </div>
      ) : null}
    </div>
  );
}

/** "Connect something else": the rest of the connectors, folded until asked for. */
export function MoreConnectors(props: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!props.count) return null;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        data-testid="work-onboarding-more"
        className="flex items-center gap-1.5 self-start rounded-md text-[13px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown aria-hidden className={cn("size-4 motion-safe:transition-transform", open ? "rotate-0" : "-rotate-90")} />
        {t("work.setup.connect_more", { count: props.count })}
      </button>
      {open ? <div id={id}>{props.children}</div> : null}
    </div>
  );
}

/** Addresses as chips in one field: type or paste many, Enter, comma or space makes a chip, Backspace on empty removes
 *  the last. */
export function EmailChips(props: { emails: string[]; onChange: (emails: string[]) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState<string[]>([]);
  const commit = (text: string) => {
    const { emails, rejected } = parseEmails(text);
    if (emails.length) props.onChange([...props.emails, ...emails.filter((email) => !props.emails.includes(email))]);
    setBad(rejected);
    setDraft(rejected.join(" "));
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30"
        data-testid="work-invite-emails"
      >
        {props.emails.map((email) => (
          <span key={email} className="flex h-6 items-center gap-1 rounded-md bg-muted ps-2 pe-0.5 text-[12px]" data-invite-email={email}>
            {email}
            <button type="button" aria-label={t("work.setup.remove_email", { email })} disabled={props.disabled} onClick={() => props.onChange(props.emails.filter((item) => item !== email))} className="flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <X aria-hidden className="size-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          disabled={props.disabled}
          onChange={(event) => {
            const value = event.target.value;
            if (/[\s,;]$/.test(value) && value.trim()) commit(value);
            else setDraft(value);
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (!/[\s,;]/.test(pasted.trim())) return;
            event.preventDefault();
            commit(`${draft} ${pasted}`);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && draft.trim()) { event.preventDefault(); event.stopPropagation(); commit(draft); }
            else if (event.key === "Backspace" && !draft && props.emails.length) props.onChange(props.emails.slice(0, -1));
          }}
          onBlur={() => { if (draft.trim()) commit(draft); }}
          placeholder={props.emails.length ? "" : t("work.setup.invite_placeholder")}
          aria-label={t("work.setup.invite_label")}
          aria-invalid={bad.length > 0 || undefined}
          className="h-6 min-w-[12rem] flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-muted-foreground"
          data-testid="work-invite-input"
        />
      </div>
      {bad.length ? <p className="text-[12px] text-destructive" role="alert">{t("work.setup.invite_bad", { emails: bad.join(", ") })}</p> : null}
    </div>
  );
}

/** The done screen's starters: a row each, Enter or click starts a Work chat with it. */
export function StarterRows(props: { starters: { title: string; prompt: string }[]; busy: boolean; onStart: (prompt: string) => void }) {
  return (
    <ul className="flex flex-col overflow-hidden rounded-xl border border-border" data-testid="work-onboarding-starters">
      {props.starters.map((starter) => (
        <li key={starter.title} className="border-b border-border last:border-b-0">
          <button
            type="button"
            disabled={props.busy}
            onClick={() => props.onStart(starter.prompt)}
            className="group flex w-full items-center gap-3 px-4 py-3 text-start text-[13px] outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 disabled:opacity-60"
            data-work-starter={starter.title}
          >
            <span className="min-w-0 flex-1 truncate">{starter.title}</span>
            <ArrowRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform motion-safe:group-hover:translate-x-0.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The step's buttons, right-aligned: Back (when there is one), Skip, then the main action. */
export function StepActions(props: { onBack?: () => void; onSkip?: () => void; skipLabel?: string; primary: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-1" data-testid={props.testId}>
      {props.onBack ? (
        <Button type="button" variant="ghost" size="sm" className="-ms-2 text-muted-foreground" onClick={props.onBack} data-testid="work-onboarding-back">{t("work.setup.back")}</Button>
      ) : <span />}
      <div className="flex items-center gap-2">
        {props.onSkip ? <Button type="button" variant="ghost" size="sm" onClick={props.onSkip} data-testid="work-onboarding-skip">{props.skipLabel ?? t("work.onboarding.skip")}</Button> : null}
        {props.primary}
      </div>
    </div>
  );
}
