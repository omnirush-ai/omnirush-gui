/** @jsxImportSource react */
import { AlertTriangle, Check, Copy, Download, ExternalLink, MessageCircle, Palette, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { downloadTextAsFile } from "@/app/lib/download";
import { contrastRows } from "@/app/themes/contrast";
import {
  MAX_THEME_BYTES,
  decodeShareCode,
  encodeShareCode,
  parseThemeJson,
  serializeTheme,
  themeFileName,
  type ThemeImportResult,
} from "@/app/themes/share";
import type { CustomTheme } from "@/app/themes/types";
import { usePlatform } from "@/react-app/kernel/platform";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
} from "../settings-layout";
import { ThemeVariantThumb } from "./theme-preview";
import { t } from "@/i18n";

export const DISCORD_SHOWCASE_URL = "https://discord.com/channels/1554572994326827069/1556709953916641280";
export const DISCORD_INVITE_URL = "https://discord.gg/9nu5rMQTDP";

type Props = {
  customTheme: CustomTheme | null;
  /** The theme being previewed after an import, if any. */
  importing: { theme: CustomTheme; source: string } | null;
  onImportPreview: (theme: CustomTheme, source: string) => void;
  onKeep: () => void;
  onEditFirst: () => void;
  onCancelImport: () => void;
};

/** Pairs checked and failing across every version of a theme. */
export function themeContrastSummary(theme: CustomTheme) {
  let checked = 0;
  const failing: Array<{ mode: string; label: string; ratio: number; target: number }> = [];
  for (const mode of theme.modes) {
    for (const row of contrastRows(theme[mode]!)) {
      checked += 1;
      if (!row.pass) failing.push({ mode, label: row.label, ratio: row.ratio, target: row.target });
    }
  }
  return { checked, failing };
}

function ImportPreviewCard(props: Pick<Props, "onKeep" | "onEditFirst" | "onCancelImport"> & { theme: CustomTheme; source: string }) {
  const summary = themeContrastSummary(props.theme);
  const modes = props.theme.modes.join(" + ");
  return (
    <div className="flex flex-col gap-3" data-testid="theme-import-preview">
      <div className="flex gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
        <Palette className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <b className="text-foreground">Previewing “{props.theme.name}”</b>
          <span className="text-muted-foreground"> · {modes} · from {props.source}</span>
          <div className="text-xs text-muted-foreground">The whole window shows it now. Nothing is saved yet.</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {props.theme.modes.map((mode) => (
          <div key={mode} className="h-16 overflow-hidden rounded-lg border border-border">
            <ThemeVariantThumb variant={props.theme[mode]!} />
          </div>
        ))}
      </div>
      {summary.failing.length === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="size-3" /> All {summary.checked} contrast pairs pass
          {props.theme.modes.length > 1 ? " in both modes" : ""}
        </p>
      ) : (
        <div className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-xs" role="alert" data-testid="theme-import-contrast">
          <b className="flex items-center gap-1.5 text-foreground">
            <AlertTriangle className="size-3.5 text-warning" />
            {summary.failing.length} of {summary.checked} contrast pairs fail
          </b>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {summary.failing.slice(0, 6).map((row, index) => (
              <li key={index}>
                {row.mode}: {row.label} {row.ratio.toFixed(1)}:1 (needs {row.target}:1)
              </li>
            ))}
            {summary.failing.length > 6 ? <li>and {summary.failing.length - 6} more</li> : null}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {summary.failing.length === 0 ? (
          <>
            <Button size="sm" onClick={props.onKeep} data-testid="theme-import-keep">
              {t("settings.theme_share.keep")}
            </Button>
            <Button size="sm" variant="outline" onClick={props.onEditFirst} data-testid="theme-import-edit">
              {t("settings.theme_share.edit_first")}
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={props.onEditFirst} data-testid="theme-import-edit">
            {t("settings.theme_share.fix_in_editor")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={props.onCancelImport} data-testid="theme-import-cancel">
          {t("common.cancel")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Keeping it adds it to your custom themes.</p>
    </div>
  );
}

export function ThemeShareSection(props: Props) {
  const platform = usePlatform();
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    if (!props.customTheme) {
      setCode("");
      return;
    }
    void encodeShareCode(props.customTheme).then((value) => {
      if (!cancelled) setCode(value);
    });
    return () => {
      cancelled = true;
    };
  }, [props.customTheme]);

  const handleResult = (result: ThemeImportResult, source: string) => {
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    props.onImportPreview(result.theme, source);
  };

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const openFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_THEME_BYTES) {
      setError("the theme is larger than 8 KB");
      return;
    }
    handleResult(parseThemeJson(await file.text()), "a theme file");
  };

  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader className="w-full">
        <LayoutSectionItemTitle>{t("settings.theme_share.title")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>
          {t("settings.theme_share.desc")}
        </LayoutSectionItemDescription>
      </LayoutSectionItemHeader>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3">
        <span className="w-14 text-sm font-medium text-foreground">{t("settings.export")}</span>
        <input
          readOnly
          aria-label={t("settings.theme_share.code")}
          value={code || t("settings.theme_share.no_code")}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 truncate rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs text-muted-foreground outline-none"
          data-testid="theme-export-code"
        />
        <Button size="sm" disabled={!code} onClick={() => void copy()} data-testid="theme-copy-code">
          {copied ? <Check /> : <Copy />}
          {copied ? t("config.copied") : t("settings.theme_share.copy")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!props.customTheme}
          onClick={() => {
            if (props.customTheme) {
              downloadTextAsFile(themeFileName(props.customTheme), serializeTheme(props.customTheme, true), "application/json");
            }
          }}
          data-testid="theme-save-file"
        >
          <Download />
          {t("settings.theme_share.save_file")}
        </Button>
      </div>

      <div className="grid gap-3 @2xl/settings:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <span className="text-sm font-medium text-foreground">{t("den.import_provider")}</span>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void decodeShareCode(input).then((result) => handleResult(result, "a theme code"));
            }}
          >
            <input
              aria-label={t("settings.theme_share.paste")}
              placeholder="omnirush-theme:1:…"
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                setError(null);
              }}
              aria-invalid={error ? true : undefined}
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground outline-none aria-invalid:border-destructive focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="theme-import-input"
            />
            <Button size="sm" variant="outline" type="submit" disabled={!input.trim()} data-testid="theme-import-preview-button">
{t("settings.theme_share.preview")}
            </Button>
          </form>
          {error ? (
            <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert" data-testid="theme-import-error">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span>
                <b>{t("settings.theme_share.invalid")}</b> {t("settings.theme_share.invalid_detail", { error })}
              </span>
            </p>
          ) : null}
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              data-testid="theme-import-file"
              onChange={(event) => {
                void openFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload />
              {t("settings.theme_share.open_file")}
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            <b className="text-foreground">{t("settings.theme_share.rules_title")}</b>
            <ul className="mt-1 list-disc pl-5">
              <li>{t("settings.theme_share.rule_prefix")}</li>
              <li>{t("settings.theme_share.rule_colours")}</li>
              <li>{t("settings.theme_share.rule_keys")}</li>
              <li>{t("settings.theme_share.rule_size")}</li>
              <li>{t("settings.theme_share.rule_ranges")}</li>
              <li>{t("settings.theme_share.rule_modes")}</li>
            </ul>
          </div>
        </div>
        <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
          <span className="text-sm font-medium text-foreground">{t("settings.theme_share.preview_confirm")}</span>
          {props.importing ? (
            <ImportPreviewCard
              theme={props.importing.theme}
              source={props.importing.source}
              onKeep={props.onKeep}
              onEditFirst={props.onEditFirst}
              onCancelImport={props.onCancelImport}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("settings.theme_share.preview_hint")}
            </p>
          )}
        </div>
      </div>

      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <MessageCircle className="size-3.5" />
          <button
            type="button"
            className="text-foreground underline underline-offset-2"
            onClick={() => platform.openLink(DISCORD_SHOWCASE_URL)}
            data-testid="theme-discord-showcase"
          >
            {t("settings.theme_share.discord_share")}
          </button>
          <ExternalLink className="size-3" />
        </span>
        <span>
          {t("settings.theme_share.not_member")}{" "}
          <button
            type="button"
            className="text-foreground underline underline-offset-2"
            onClick={() => platform.openLink(DISCORD_INVITE_URL)}
            data-testid="theme-discord-join"
          >
            {t("settings.theme_share.join_discord")}
          </button>
        </span>
      </p>
    </LayoutSectionItem>
  );
}
