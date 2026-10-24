/** @jsxImportSource react */
import { Check, Moon, Pencil, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { THEME_PRESETS } from "@/app/themes/presets";
import { presetModes } from "@/app/themes/palette";
import type { SavedCustomTheme } from "@/app/theme";
import type { ThemeVariant } from "@/app/themes/types";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
} from "../settings-layout";
import { ThemeVariantThumb } from "./theme-preview";
import { t } from "@/i18n";

type Props = {
  busy: boolean;
  /** Selected preset id, or `custom:<id>` for a saved custom theme. */
  selectedId: string;
  customThemes: SavedCustomTheme[];
  maxCustomThemes: number;
  note: string | null;
  onPickPreset: (id: string) => void;
  onPickCustom: (id: string) => void;
  onEditCustom: (id: string) => void;
  onDeleteCustom: (id: string) => void;
  onNewCustom: () => void;
};

const modesLabel = (modes: readonly string[]) =>
  modes.length === 2 ? t("settings.appearance.light_dark") : modes[0] === "dark" ? t("settings.appearance.dark_only") : t("settings.appearance.light_only");

function swatchesOf(v: ThemeVariant) {
  return [v.accent, v.surface, v.code.string, v.code.function];
}

function Thumbs(props: { light?: ThemeVariant; dark?: ThemeVariant }) {
  if (props.light && props.dark) {
    return (
      <div className="grid h-full grid-cols-2">
        <ThemeVariantThumb variant={props.light} swatches={swatchesOf(props.light)} />
        <ThemeVariantThumb variant={props.dark} swatches={swatchesOf(props.dark)} />
      </div>
    );
  }
  const only = (props.light ?? props.dark)!;
  return <ThemeVariantThumb variant={only} swatches={swatchesOf(only)} />;
}

function Card(props: {
  selected: boolean;
  label: string;
  meta: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
  action?: ReactNode;
  testId: string;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        role="radio"
        aria-checked={props.selected}
        disabled={props.disabled}
        onClick={props.onClick}
        data-testid={props.testId}
        className={cn(
          "group flex w-full flex-col gap-2 rounded-xl border border-border bg-card p-1.5 text-left outline-none transition-shadow hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring",
          props.selected && "border-foreground ring-1 ring-foreground",
        )}
      >
        <div className="h-16 w-full overflow-hidden rounded-lg border border-border">{props.children}</div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 px-1 pb-0.5 text-xs">
          <span className="flex min-w-0 items-center gap-1 font-medium text-foreground">
            {props.selected ? <Check className="size-3 shrink-0" /> : null}
            <span className="break-words">{props.label}</span>
          </span>
          <span className="text-muted-foreground">{props.meta}</span>
        </div>
      </button>
      {props.action}
    </div>
  );
}

export function ThemePresetsSection(props: Props) {
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader className="w-full">
        <LayoutSectionItemTitle>{t("settings.theme_title")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>
          {t("settings.appearance.presets_desc")}
        </LayoutSectionItemDescription>
      </LayoutSectionItemHeader>
      <div role="radiogroup" aria-label={t("settings.theme_title")} className="grid grid-cols-2 gap-3 @xl/settings:grid-cols-3 @3xl/settings:grid-cols-4">
        {THEME_PRESETS.map((preset) => (
          <Card
            key={preset.id}
            testId={`theme-preset-${preset.id}`}
            selected={props.selectedId === preset.id}
            label={preset.id === "default" ? t("settings.appearance.preset_default") : preset.id === "high-contrast" ? t("settings.appearance.preset_high_contrast") : preset.name}
            meta={modesLabel(presetModes(preset))}
            disabled={props.busy}
            onClick={() => props.onPickPreset(preset.id)}
          >
            <Thumbs light={preset.variants.light} dark={preset.variants.dark} />
          </Card>
        ))}
        {props.customThemes.map(({ id, theme }) => (
          <Card
            key={id}
            testId={`theme-custom-${id}`}
            selected={props.selectedId === `custom:${id}`}
            label={theme.name}
            meta={modesLabel(theme.modes)}
            disabled={props.busy}
            onClick={() => props.onPickCustom(id)}
            action={
              <div className="absolute right-3 top-3 flex gap-1">
                <button
                  type="button"
                  onClick={() => props.onEditCustom(id)}
                  aria-label={t("settings.appearance.edit_theme", { name: theme.name })}
                  data-testid={`theme-edit-${id}`}
                  className="flex size-6 items-center justify-center rounded-md border border-border bg-popover text-foreground shadow-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Pencil className="size-3" />
                </button>
                <button
                  type="button"
                  onClick={() => props.onDeleteCustom(id)}
                  aria-label={t("settings.appearance.delete_theme", { name: theme.name })}
                  data-testid={`theme-delete-${id}`}
                  className="flex size-6 items-center justify-center rounded-md border border-border bg-popover text-foreground shadow-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            }
          >
            <Thumbs light={theme.light} dark={theme.dark} />
          </Card>
        ))}
        <button
          type="button"
          onClick={props.onNewCustom}
          disabled={props.busy || props.customThemes.length >= props.maxCustomThemes}
          data-testid="theme-new-custom"
          className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-1.5 text-left text-xs text-muted-foreground outline-none hover:border-foreground/25 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex h-16 w-full items-center justify-center rounded-lg border border-dashed border-border">
            <Plus className="size-4" />
          </span>
          <span className="px-1 pb-0.5 font-medium">
            {props.customThemes.length >= props.maxCustomThemes ? t("settings.appearance.max_custom_themes", { count: props.maxCustomThemes }) : t("settings.appearance.new_custom_theme")}
          </span>
        </button>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="theme-mode-note" role="status">
        <Moon className="size-3 shrink-0" />
        {props.note ?? t("settings.appearance.midnight_note")}
      </p>
    </LayoutSectionItem>
  );
}
