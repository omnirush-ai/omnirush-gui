/** @jsxImportSource react */
/** Settings → Editor: the IDE layout's code editor (text, saving, language features, keys). */
import { useEffect, useMemo, useRef, useState } from "react";

import type { OmniRushServerClient } from "@/app/lib/omnirush-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useEditorStore } from "../../session/editor/editor-store";
import {
  EDITOR_FONT_SIZES,
  EDITOR_SHORTCUTS,
  useEditorSettings,
  type AutoSave,
  type EditorSettings,
} from "../../session/editor/editor-settings";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";
import { t } from "@/i18n";

const SEGMENT =
  "h-7 rounded-md border border-transparent px-3 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring aria-checked:border-foreground/70 aria-checked:bg-background aria-checked:font-medium aria-checked:text-foreground aria-checked:shadow-xs";
const GROUP = "flex w-fit gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5";

/** A row of choices that is a real radio group: one tab stop, arrow keys (and Home/End) change the choice. */
function SegmentedRadio<T extends string>(props: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const select = (index: number) => {
    const count = props.options.length;
    const next = ((index % count) + count) % count;
    props.onChange(props.options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={props.label} className={GROUP}>
      {props.options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            refs.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === props.value}
          tabIndex={option.value === props.value ? 0 : -1}
          className={SEGMENT}
          onClick={() => props.onChange(option.value)}
          onKeyDown={(event) => {
            const keys: Record<string, number> = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: props.options.length - 1 };
            const next = keys[event.key];
            if (next === undefined) return;
            event.preventDefault();
            select(next);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SwitchRow(props: { title: string; description: string; checked: boolean; onChange: (value: boolean) => void; id: string }) {
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>
          <label htmlFor={props.id}>{props.title}</label>
        </LayoutSectionItemTitle>
        <LayoutSectionItemDescription>{props.description}</LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <Switch id={props.id} aria-label={props.title} checked={props.checked} onCheckedChange={props.onChange} />
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
    </LayoutSectionItem>
  );
}

/** Which formatters the open project has, for the "Format on save" row. */
function useProjectFormatters(client: OmniRushServerClient | null, workspaceId: string | null) {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setNames(null);
    if (!client || !workspaceId) return;
    client.editorFormatters(workspaceId).then(
      (result) => {
        if (!cancelled) setNames(result.formatters);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId]);
  return names;
}

export function EditorSettingsView(props: { client: OmniRushServerClient | null; workspaceId: string | null }) {
  const settings = useEditorSettings();
  const languageFeatures = useEditorStore((state) => state.languageFeatures);
  const setLanguageFeatures = useEditorStore((state) => state.setLanguageFeatures);
  const formatters = useProjectFormatters(props.client, props.workspaceId);
  const [keysOpen, setKeysOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const set = <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => settings.set(key, value);
  const shortcuts = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? EDITOR_SHORTCUTS.filter((item) => `${item.keys} ${item.action}`.toLowerCase().includes(needle)) : EDITOR_SHORTCUTS;
  }, [filter]);

  const formatterNote = !props.workspaceId
    ? t("settings.editor.formatter_no_project")
    : formatters === null
      ? t("settings.editor.formatter_loading")
      : formatters.length
        ? t("settings.editor.formatter_found", { list: formatters.join(", ") })
        : t("settings.editor.formatter_none");

  return (
    <LayoutStack>
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.editor.text")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.editor.text_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>
              <label htmlFor="editor-font-size">{t("settings.editor.font_size")}</label>
            </LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.editor.font_size_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <select
                id="editor-font-size"
                value={settings.fontSize}
                onChange={(event) => set("fontSize", Number(event.target.value))}
                className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                data-editor-setting="fontSize"
              >
                {EDITOR_FONT_SIZES.map((size) => <option key={size} value={size}>{size} px</option>)}
              </select>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
        <LayoutSectionItem>
          <LayoutSectionItemHeader className="w-full">
            <LayoutSectionItemTitle>{t("settings.editor.tab_size")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.editor.tab_size_desc")}</LayoutSectionItemDescription>
          </LayoutSectionItemHeader>
          <SegmentedRadio
            label={t("settings.editor.tab_size")}
            value={String(settings.tabSize) as "2" | "4" | "8"}
            options={[{ value: "2", label: "2" }, { value: "4", label: "4" }, { value: "8", label: "8" }]}
            onChange={(value) => set("tabSize", Number(value) as EditorSettings["tabSize"])}
          />
        </LayoutSectionItem>
        <SwitchRow id="editor-word-wrap" title={t("settings.editor.word_wrap")} description={t("settings.editor.word_wrap_desc")} checked={settings.wordWrap} onChange={(value) => set("wordWrap", value)} />
        <SwitchRow id="editor-minimap" title={t("settings.editor.minimap")} description={t("settings.editor.minimap_desc")} checked={settings.minimap} onChange={(value) => set("minimap", value)} />
        <SwitchRow id="editor-sticky-scroll" title={t("settings.editor.sticky_scroll")} description={t("settings.editor.sticky_scroll_desc")} checked={settings.stickyScroll} onChange={(value) => set("stickyScroll", value)} />
      </LayoutSection>

      <Separator />

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.editor.saving")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.editor.saving_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>
        <LayoutSectionItem>
          <LayoutSectionItemHeader className="w-full">
            <LayoutSectionItemTitle>{t("settings.editor.auto_save")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.editor.auto_save_desc")}</LayoutSectionItemDescription>
          </LayoutSectionItemHeader>
          <SegmentedRadio<AutoSave>
            label={t("settings.editor.auto_save")}
            value={settings.autoSave}
            options={[{ value: "off", label: t("common.off") }, { value: "afterDelay", label: t("settings.editor.after_delay") }, { value: "onFocusChange", label: t("settings.editor.on_focus_change") }]}
            onChange={(value) => set("autoSave", value)}
          />
        </LayoutSectionItem>
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>
              <label htmlFor="editor-format-on-save">{t("settings.editor.format_on_save")}</label>
            </LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {t("settings.editor.format_on_save_desc")}
              {" "}<span data-editor-formatter>{formatterNote}</span>
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch id="editor-format-on-save" aria-label="Format on save" checked={settings.formatOnSave} onCheckedChange={(value) => set("formatOnSave", value)} />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>

      <Separator />

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.editor.language_features")}</LayoutSectionTitle>
        </LayoutSectionHeader>
        <SwitchRow
          id="editor-language-features"
          title={t("settings.editor.language_features_title")}
          description={t("settings.editor.language_features_desc")}
          checked={languageFeatures}
          onChange={setLanguageFeatures}
        />
      </LayoutSection>

      <Separator />

      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.editor.keys")}</LayoutSectionTitle>
        </LayoutSectionHeader>
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.editor.keyboard_shortcuts")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.editor.keyboard_shortcuts_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Button variant="outline" size="sm" onClick={() => setKeysOpen(true)} data-editor-shortcuts-open>{t("settings.editor.show_all")}</Button>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>

      <Dialog open={keysOpen} onOpenChange={setKeysOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settings.editor.shortcuts_title")}</DialogTitle>
            <DialogDescription>{t("settings.editor.shortcuts_desc")}</DialogDescription>
          </DialogHeader>
          <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("settings.editor.search_shortcuts")} aria-label={t("settings.editor.search_shortcuts")} />
          <ul className="max-h-80 overflow-y-auto text-sm" aria-label={t("settings.editor.shortcuts")}>
            {shortcuts.map((item) => (
              <li key={item.keys} className="flex items-center justify-between gap-4 border-b border-border py-1.5 last:border-0">
                <span>{item.action}</span>
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{item.keys}</kbd>
              </li>
            ))}
            {!shortcuts.length ? <li className="py-2 text-muted-foreground">{t("settings.editor.no_shortcut_matches")}</li> : null}
          </ul>
        </DialogContent>
      </Dialog>
    </LayoutStack>
  );
}
