/** @jsxImportSource react */
import { Monitor, Moon, Sun } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { t } from "@/i18n";
import type { AppearanceViewProps } from "../pages/appearance-view";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
} from "../settings-layout";

type ThemeMode = AppearanceViewProps["themeMode"];

interface ThemeSectionProps
  extends Pick<AppearanceViewProps, "busy" | "themeMode" | "setThemeMode"> {}

/** Mode: light, dark or follow the system. The theme below picks the colours for each. */
export function ThemeSection(props: ThemeSectionProps) {
  const items: Array<{ value: ThemeMode; label: string; icon: typeof Sun }> = [
    { value: "light", label: t("settings.theme_light"), icon: Sun },
    { value: "dark", label: t("settings.theme_dark"), icon: Moon },
    { value: "system", label: t("settings.theme_system"), icon: Monitor },
  ];
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader className="w-full">
        <LayoutSectionItemTitle>{t("settings.appearance.mode")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>{t("settings.appearance.mode_desc")}</LayoutSectionItemDescription>
      </LayoutSectionItemHeader>
      <ToggleGroup
        value={[props.themeMode]}
        onValueChange={(value) => {
          if (!value[0]) return;
          props.setThemeMode(value[0] as ThemeMode);
        }}
        disabled={props.busy}
        aria-label={t("settings.appearance.mode")}
        className="w-fit gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5"
      >
        {items.map((item) => (
          <ToggleGroupItem
            key={item.value}
            value={item.value}
            aria-label={item.label}
            className="h-7 gap-1.5 rounded-md border border-transparent px-3 text-sm text-muted-foreground aria-pressed:border-foreground/70 aria-pressed:bg-background aria-pressed:font-medium aria-pressed:text-foreground aria-pressed:shadow-xs"
          >
            <item.icon className="size-3.5" />
            {item.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </LayoutSectionItem>
  );
}
