/** @jsxImportSource react */
import { AlertTriangle, Check, ImagePlus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { setAppearancePrefs } from "@/app/theme";
import {
  ACCENT_SWATCHES,
  CODE_FONTS,
  PANEL_BLUR_RANGE,
  PANEL_OPACITY_RANGE,
  UI_FONTS,
  WALLPAPER_DIM_RANGE,
  checkAccent,
  codeFontStack,
  normalizeHex,
  textOnAccent,
  uiFontStack,
  type AppearancePrefs,
} from "@/app/themes/appearance-prefs";
import { FONT_SIZE_RANGE, RADIUS_RANGE } from "@/app/themes/types";
import { removeWallpaper, setWallpaperFromFile, WALLPAPER_TYPES } from "@/app/wallpaper";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
} from "../settings-layout";
import { useActiveTheme, useAppearancePrefs } from "./theme-state";
import { t } from "@/i18n";

type SectionProps = { busy: boolean };

function Section(props: { title: string; description: string; children: ReactNode; testId: string }) {
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader className="w-full">
        <LayoutSectionItemTitle>{props.title}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>{props.description}</LayoutSectionItemDescription>
      </LayoutSectionItemHeader>
      <div className="flex flex-col gap-1" data-testid={props.testId}>
        {props.children}
      </div>
    </LayoutSectionItem>
  );
}

function Row(props: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-center gap-2 py-1.5 @md/settings:grid-cols-[9rem_1fr]">
      <label htmlFor={props.htmlFor} className="text-sm text-foreground">
        {props.label}
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-3">{props.children}</div>
    </div>
  );
}

/** Descriptive font choices are translated; named fonts keep their names. */
function fontLabel(option: { id: string; label: string }): string {
  if (option.label === "System default") return t("voice.system_default");
  if (option.label === "System monospace") return t("settings.appearance.system_monospace");
  if (option.label === "Same as code font") return t("settings.appearance.same_as_code_font");
  return option.label;
}

/** A range input with its value and an optional "Theme default" reset. */
function Slider(props: {
  label: string;
  value: number;
  range: { min: number; max: number };
  unit: string;
  disabled: boolean;
  onChange: (value: number) => void;
  onReset?: () => void;
  resetLabel?: string;
  testId: string;
}) {
  const id = useId();
  return (
    <Row label={props.label} htmlFor={id}>
      <input
        id={id}
        type="range"
        min={props.range.min}
        max={props.range.max}
        step={1}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className="w-44 accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
        data-testid={props.testId}
      />
      <span className="font-mono text-xs text-muted-foreground tabular-nums">
        {Math.round(props.value)}
        {props.unit}
      </span>
      {props.onReset ? (
        <Button variant="ghost" size="sm" onClick={props.onReset} disabled={props.disabled}>
          {props.resetLabel ?? t("common.reset")}
        </Button>
      ) : null}
    </Row>
  );
}

const ratio = (value: number) => `${value.toFixed(1)}:1`;

/** Accent colour: theme default, a swatch or any hex. Buttons, focus rings, selection and links follow it. */
export function AccentSection(props: SectionProps) {
  const prefs = useAppearancePrefs();
  const active = useActiveTheme();
  const [draft, setDraft] = useState(prefs.accent ?? "");
  const inputId = useId();
  useEffect(() => setDraft(prefs.accent ?? ""), [prefs.accent]);

  const setAccent = (accent: string | null) => setAppearancePrefs({ accent });
  const check = prefs.accent ? checkAccent(active.variant, prefs.accent) : null;
  const themeAccent = active.themeAccent ?? active.variant.accent;
  const pickerValue = prefs.accent ?? normalizeHex(themeAccent) ?? "#000000";

  const swatch = (label: string, hex: string | null, fill: string) => {
    const selected = prefs.accent === hex;
    return (
      <button
        key={label}
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={label}
        title={label}
        disabled={props.busy}
        onClick={() => setAccent(hex)}
        data-testid={`accent-${hex ?? "theme"}`}
        className={cn(
          "flex size-7 items-center justify-center rounded-full border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          selected && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
        )}
        style={{ background: fill }}
      >
        {selected ? <Check className="size-3.5" style={{ color: textOnAccent(fill) }} /> : null}
      </button>
    );
  };

  return (
    <Section
      title={t("settings.appearance.accent_title")}
      description={t("settings.appearance.accent_desc")}
      testId="appearance-accent"
    >
      <div role="radiogroup" aria-label="Accent colour" className="flex flex-wrap items-center gap-2 py-1">
        {swatch(t("settings.appearance.theme_accent"), null, themeAccent)}
        {ACCENT_SWATCHES.map((item) => swatch(item.name, item.hex, item.hex))}
      </div>
      <Row label={t("settings.appearance.custom_colour")} htmlFor={inputId}>
        <label className="relative size-7 shrink-0 overflow-hidden rounded-md border border-border" style={{ background: pickerValue }}>
          <input
            type="color"
            aria-label={t("settings.appearance.pick_accent")}
            value={pickerValue}
            disabled={props.busy}
            onChange={(event) => setAccent(event.target.value.toLowerCase())}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
            data-testid="accent-picker"
          />
        </label>
        <Input
          id={inputId}
          value={draft}
          placeholder="#3b6fe0"
          spellCheck={false}
          maxLength={7}
          disabled={props.busy}
          className="h-8 w-28 font-mono"
          aria-invalid={draft !== "" && !normalizeHex(draft)}
          onChange={(event) => {
            setDraft(event.target.value);
            const hex = normalizeHex(event.target.value);
            if (hex && event.target.value.replace("#", "").length === 6) setAccent(hex);
          }}
          onBlur={() => setDraft(prefs.accent ?? "")}
          data-testid="accent-hex"
        />
      </Row>
      {check && !check.ok ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs" data-testid="accent-warning">
          <AlertTriangle className="size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-foreground">
            {check.uiRatio < 3 ? `Hard to see on this theme: ${ratio(check.uiRatio)} (needs 3:1). ` : ""}
            {check.textRatio < 4.5 ? `Button text on it is ${ratio(check.textRatio)} (needs 4.5:1). ` : ""}
            {t("settings.appearance.links_readable")}
          </span>
          {check.suggestion ? (
            <Button size="sm" variant="outline" onClick={() => setAccent(check.suggestion)} data-testid="accent-use-suggestion">
              <span className="size-3 rounded-full border border-border" style={{ background: check.suggestion }} />
              Use {check.suggestion}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}

function FontSelect(props: {
  label: string;
  value: string;
  options: readonly { id: string; label: string }[];
  stackOf: (id: string) => string | undefined;
  disabled: boolean;
  onChange: (id: string) => void;
  testId: string;
}) {
  const items = props.options.map((option) => ({ value: option.id, label: fontLabel(option) }));
  return (
    <Row label={props.label}>
      <div className="w-64 max-w-full">
        <Select value={props.value} items={items} onValueChange={(value) => value && props.onChange(value)} disabled={props.disabled}>
          <SelectTrigger className="w-full" aria-label={props.label} data-testid={props.testId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {props.options.map((option) => (
                <SelectItem key={option.id} value={option.id} style={{ fontFamily: props.stackOf(option.id) }}>
                  {fontLabel(option)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    </Row>
  );
}

/** Interface font, code font and text size. */
export function FontsSection(props: SectionProps) {
  const prefs = useAppearancePrefs();
  const active = useActiveTheme();
  const set = (patch: Partial<AppearancePrefs>) => setAppearancePrefs(patch);
  return (
    <Section
      title={t("settings.appearance.fonts_title")}
      description={t("settings.appearance.fonts_desc")}
      testId="appearance-fonts"
    >
      <FontSelect
        label={t("settings.appearance.interface_font")}
        value={prefs.uiFont}
        options={UI_FONTS}
        stackOf={(id) => uiFontStack({ uiFont: id as AppearancePrefs["uiFont"], codeFont: prefs.codeFont }) ?? undefined}
        disabled={props.busy}
        onChange={(id) => set({ uiFont: id as AppearancePrefs["uiFont"] })}
        testId="appearance-ui-font"
      />
      <FontSelect
        label={t("settings.appearance.code_font")}
        value={prefs.codeFont}
        options={CODE_FONTS}
        stackOf={(id) => codeFontStack({ codeFont: id as AppearancePrefs["codeFont"] })}
        disabled={props.busy}
        onChange={(id) => set({ codeFont: id as AppearancePrefs["codeFont"] })}
        testId="appearance-code-font"
      />
      <Slider
        label={t("settings.appearance.text_size")}
        value={prefs.fontSizePx ?? active.fontSizePx}
        range={FONT_SIZE_RANGE}
        unit=" px"
        disabled={props.busy}
        onChange={(fontSizePx) => set({ fontSizePx })}
        onReset={prefs.fontSizePx === null ? undefined : () => set({ fontSizePx: null })}
        resetLabel={t("settings.appearance.theme_default")}
        testId="appearance-text-size"
      />
      <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground" data-testid="appearance-font-sample">
        The agent replied: <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">npm run build</code> finished in 4.2 s.
      </p>
    </Section>
  );
}

/** Density and corner radius. */
export function LayoutLookSection(props: SectionProps) {
  const prefs = useAppearancePrefs();
  const active = useActiveTheme();
  return (
    <Section title={t("ide.layout")} description={t("settings.appearance.layout_desc")} testId="appearance-layout">
      <Row label={t("settings.appearance.density")}>
        <ToggleGroup
          value={[prefs.density]}
          onValueChange={(value) => value[0] && setAppearancePrefs({ density: value[0] as AppearancePrefs["density"] })}
          disabled={props.busy}
          aria-label="Density"
          className="w-fit gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5"
        >
          {(["comfortable", "compact"] as const).map((value) => (
            <ToggleGroupItem
              key={value}
              value={value}
              data-testid={`appearance-density-${value}`}
              className="h-7 rounded-md border border-transparent px-3 text-sm text-muted-foreground capitalize aria-pressed:border-foreground/70 aria-pressed:bg-background aria-pressed:font-medium aria-pressed:text-foreground aria-pressed:shadow-xs"
            >
              {value === "compact" ? t("settings.appearance.density_compact") : t("settings.appearance.density_comfortable")}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Row>
      <Slider
        label={t("settings.appearance.corner_radius")}
        value={prefs.radiusPx ?? active.radiusPx}
        range={RADIUS_RANGE}
        unit=" px"
        disabled={props.busy}
        onChange={(radiusPx) => setAppearancePrefs({ radiusPx })}
        onReset={prefs.radiusPx === null ? undefined : () => setAppearancePrefs({ radiusPx: null })}
        resetLabel={t("settings.appearance.theme_default")}
        testId="appearance-radius"
      />
    </Section>
  );
}

function useReducedTransparency() {
  const query = "(prefers-reduced-transparency: reduce)";
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const onChange = () => setReduced(list.matches);
    list.addEventListener?.("change", onChange);
    return () => list.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/** A picture behind the window, how much it is dimmed, and how see-through the panels over it are. */
export function WallpaperSection(props: SectionProps) {
  const prefs = useAppearancePrefs();
  const reduced = useReducedTransparency();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setWorking(true);
    setError(null);
    try {
      await setWallpaperFromFile(file);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That image could not be used.");
    } finally {
      setWorking(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Section
      title={t("settings.appearance.wallpaper")}
      description={t("settings.appearance.wallpaper_desc")}
      testId="appearance-wallpaper"
    >
      <div className="flex flex-wrap items-center gap-2 py-1">
        <input
          ref={fileRef}
          type="file"
          accept={WALLPAPER_TYPES.join(",")}
          className="hidden"
          onChange={(event) => void choose(event.target.files?.[0])}
          data-testid="wallpaper-file"
        />
        <Button size="sm" variant="outline" disabled={props.busy || working} onClick={() => fileRef.current?.click()} data-testid="wallpaper-choose">
          <ImagePlus className="size-3.5" />
          {prefs.wallpaper ? t("settings.appearance.change_image") : t("settings.appearance.choose_image")}
        </Button>
        {prefs.wallpaper ? (
          <Button size="sm" variant="ghost" disabled={props.busy || working} onClick={() => void removeWallpaper()} data-testid="wallpaper-remove">
            <Trash2 className="size-3.5" />
            {t("common.remove")}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">{t("settings.appearance.image_types")}</span>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive" data-testid="wallpaper-error">
          {error}
        </p>
      ) : null}
      {prefs.wallpaper ? (
        <>
          <Slider
            label={t("settings.appearance.dim_picture")}
            value={prefs.wallpaperDim}
            range={WALLPAPER_DIM_RANGE}
            unit="%"
            disabled={props.busy}
            onChange={(wallpaperDim) => setAppearancePrefs({ wallpaperDim })}
            testId="wallpaper-dim"
          />
          <Slider
            label={t("settings.appearance.panel_opacity")}
            value={reduced ? 100 : prefs.panelOpacity}
            range={PANEL_OPACITY_RANGE}
            unit="%"
            disabled={props.busy || reduced}
            onChange={(panelOpacity) => setAppearancePrefs({ panelOpacity })}
            testId="wallpaper-opacity"
          />
          <Slider
            label={t("settings.appearance.sidebar_blur")}
            value={reduced ? 0 : prefs.panelBlur}
            range={PANEL_BLUR_RANGE}
            unit=" px"
            disabled={props.busy || reduced}
            onChange={(panelBlur) => setAppearancePrefs({ panelBlur })}
            testId="wallpaper-blur"
          />
          {reduced ? (
            <p className="text-xs text-muted-foreground" data-testid="wallpaper-reduced">
              {t("settings.appearance.reduced_transparency")}
            </p>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}
