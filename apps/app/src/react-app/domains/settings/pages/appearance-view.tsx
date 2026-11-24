/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { isDesktopRuntime } from "@/app/utils";
import type { Language } from "@/i18n";
import { Separator } from "@/components/ui/separator";
import {
  deleteCustomTheme,
  MAX_CUSTOM_THEMES,
  modeSwitchFor,
  saveCustomTheme,
  setThemePreview,
  setThemeSelection,
} from "@/app/theme";
import { findPreset, presetModes } from "@/app/themes/palette";
import type { CustomTheme } from "@/app/themes/types";
import { CustomThemeEditor } from "../appearance/custom-theme-editor";
import { AccentSection, FontsSection, LayoutLookSection, WallpaperSection } from "../appearance/customise-sections";
import { LanguageSection } from "../appearance/language-section";
import { ThemePresetsSection } from "../appearance/theme-presets-section";
import { ThemeSection } from "../appearance/theme-section";
import { ThemeShareSection } from "../appearance/theme-share-section";
import {
  customThemeFromPreset,
  presetName,
  trackThemeChanged,
  useActiveTheme,
  useCustomThemes,
  useSelectedCustomId,
  useThemeSelection,
} from "../appearance/theme-state";
import { WindowSection } from "../appearance/window-section";
import { LayoutStack } from "../settings-layout";
import { useEnterpriseFlags } from "../../work/enterprise-mode";

export type AppearanceViewProps = {
  busy: boolean;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
  language: Language;
  setLanguage: (value: Language) => void;
  hideTitlebar: boolean;
  toggleHideTitlebar: () => void;
};

/** `id` is the saved custom theme being edited, or null for a new one. */
type EditorState = { initial: CustomTheme; startedFrom: string; unsavedFromStart: boolean; key: number; id: string | null };

export function AppearanceView(props: AppearanceViewProps) {
  const selection = useThemeSelection();
  const customThemes = useCustomThemes();
  const selectedCustomId = useSelectedCustomId();
  const selectedCustom = customThemes.find((item) => item.id === selectedCustomId) ?? null;
  /** The theme Share offers: the one in use, else the first saved one. */
  const customTheme = (selectedCustom ?? customThemes[0])?.theme ?? null;
  const active = useActiveTheme();
  const enterprise = useEnterpriseFlags();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [importing, setImporting] = useState<{ theme: CustomTheme; source: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Leaving Appearance ends any unsaved preview.
  useEffect(() => () => setThemePreview(null), []);

  const selectedId = selectedCustomId ? `custom:${selectedCustomId}` : selection.kind === "preset" ? selection.id : "default";

  /** Single-mode themes (Midnight) switch Mode instead of silently showing the other mode. */
  const followModes = (name: string, modes: readonly ("light" | "dark")[]) => {
    const target = modeSwitchFor(modes, props.themeMode);
    if (target) {
      props.setThemeMode(target);
      setNote(`${name} is ${target} only, so Mode is now ${target === "dark" ? "Dark" : "Light"}.`);
      return target;
    }
    setNote(null);
    return props.themeMode;
  };

  const closeEditing = () => {
    setEditor(null);
    setImporting(null);
    setThemePreview(null);
  };

  const pickPreset = (id: string) => {
    const preset = findPreset(id);
    if (!preset) return;
    closeEditing();
    const mode = followModes(preset.name, presetModes(preset));
    setThemeSelection({ kind: "preset", id });
    trackThemeChanged({ kind: "preset", preset: id, mode });
  };

  const pickCustom = (id: string) => {
    const saved = customThemes.find((item) => item.id === id);
    if (!saved) return;
    closeEditing();
    const mode = followModes(saved.theme.name, saved.theme.modes);
    setThemeSelection({ kind: "custom", id });
    trackThemeChanged({ kind: "custom", mode });
  };

  const openEditor = (initial: CustomTheme, startedFrom: string, unsavedFromStart: boolean, id: string | null = null) => {
    setImporting(null);
    setEditor({ initial, startedFrom, unsavedFromStart, key: Date.now(), id });
    setThemePreview(initial);
  };

  const editCustom = (id: string) => {
    const saved = customThemes.find((item) => item.id === id);
    if (saved) openEditor(saved.theme, `“${saved.theme.name}”`, false, id);
  };

  /** A new theme starts as a copy of what is in use (a preset or a custom theme). */
  const newCustom = () => {
    if (selectedCustom) {
      const copy = { ...selectedCustom.theme, name: `${selectedCustom.theme.name} copy`.slice(0, 40) };
      openEditor(copy, `“${selectedCustom.theme.name}”`, true);
      return;
    }
    const baseId = selection.kind === "preset" ? selection.id : "default";
    const preset = findPreset(baseId) ?? findPreset("default")!;
    const name = customThemes.length ? `My theme ${customThemes.length + 1}` : "My theme";
    openEditor(customThemeFromPreset(preset, name), presetName(preset.id), true);
  };

  const deleteCustom = (id: string) => {
    const saved = customThemes.find((item) => item.id === id);
    if (!saved || !window.confirm(`Delete the theme “${saved.theme.name}”? This cannot be undone.`)) return;
    if (editor?.id === id) closeEditing();
    deleteCustomTheme(id);
  };

  const keepTheme = (theme: CustomTheme, id: string | null) => {
    let savedId: string;
    try {
      savedId = saveCustomTheme(theme, id ?? undefined);
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : "The theme could not be saved.");
      return;
    }
    setThemePreview(null);
    const mode = followModes(theme.name, theme.modes);
    setThemeSelection({ kind: "custom", id: savedId });
    trackThemeChanged({ kind: "custom", mode });
    setEditor(null);
    setImporting(null);
  };

  // Company accounts get the two settings that matter at work: Mode and Accent colour.
  if (enterprise.on) {
    return (
      <LayoutStack>
        <ThemeSection {...props} />
        <Separator />
        <AccentSection busy={props.busy} compact />
      </LayoutStack>
    );
  }

  return (
    <LayoutStack>
      <ThemeSection {...props} />
      <Separator />
      <ThemePresetsSection
        busy={props.busy}
        selectedId={selectedId}
        customThemes={customThemes}
        maxCustomThemes={MAX_CUSTOM_THEMES}
        note={note}
        onPickPreset={pickPreset}
        onPickCustom={pickCustom}
        onEditCustom={editCustom}
        onDeleteCustom={deleteCustom}
        onNewCustom={newCustom}
      />
      {editor ? (
        <>
          <Separator />
          <CustomThemeEditor
            key={editor.key}
            initial={editor.initial}
            startedFrom={editor.startedFrom}
            unsavedFromStart={editor.unsavedFromStart}
            preferredMode={active.mode}
            onPreview={(theme) => setThemePreview(theme)}
            onApply={(theme) => keepTheme(theme, editor.id)}
            onRevert={closeEditing}
          />
        </>
      ) : null}
      <Separator />
      <AccentSection busy={props.busy} />
      <Separator />
      <FontsSection busy={props.busy} />
      <Separator />
      <LayoutLookSection busy={props.busy} />
      <Separator />
      <WallpaperSection busy={props.busy} />
      <Separator />
      <ThemeShareSection
        customTheme={customTheme}
        importing={importing}
        onImportPreview={(theme, source) => {
          setEditor(null);
          setImporting({ theme, source });
          setThemePreview(theme);
        }}
        onKeep={() => importing && keepTheme(importing.theme, null)}
        onEditFirst={() => importing && openEditor(importing.theme, importing.source, true)}
        onCancelImport={closeEditing}
      />
      <Separator />
      <LanguageSection {...props} />
      {isDesktopRuntime() ? (
        <>
          <Separator />
          <WindowSection {...props} />
        </>
      ) : null}
    </LayoutStack>
  );
}
