/** @jsxImportSource react */
// Connector marks everywhere in Work: the brand's own glyph in its colour (brands.ts), a letter where simple-icons has
// none, a plain line icon only for what is no brand (other email, other calendar, meetings). One tile style for rows
// (28 px) and chips (20 px).
import {
  AtSign, Calendar, Database, FileText, Mail, MessageSquare, Phone, Plug, Shapes, Webhook,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

import { BRAND_MARKS, type BrandMark } from "./brands";

/** What is no brand: a line icon. Search results and deals also name channels (gmail, drive, …), which have marks. */
const GENERIC_ICONS: Partial<Record<string, LucideIcon>> = {
  imap: AtSign, caldav: Calendar, meetings: Phone, mock: Shapes, demo: Database, webhook: Webhook,
  email: Mail, mail: Mail, file: FileText, message: MessageSquare,
};

export const brandMark = (id: string): BrandMark | null => BRAND_MARKS[id] ?? null;

function MicrosoftSquares(props: { className?: string; id: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-4 shrink-0", props.className)} data-connector-icon={props.id}>
      <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
      <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
      <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
      <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
    </svg>
  );
}

/** A brand colour as a CSS variable: near-black marks switch to the text colour in dark mode (static classes only). */
const fillStyle = (mark: { color: string }) => ({ "--brand": mark.color }) as CSSProperties;
const FILL = "[fill:var(--brand)]";
const DARK_FILL = "[fill:var(--brand)] dark:[fill:currentColor]";

/** A letter in the brand colour, drawn as an SVG so it scales and aligns like the glyphs. */
export function LetterMark(props: { letter: string; color?: string; dark?: boolean; className?: string; id?: string }) {
  const letter = props.letter.trim().slice(0, 1) || "?";
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-4 shrink-0", props.className)} data-connector-icon={props.id ?? "letter"}>
      <text
        x="12"
        y="17.6"
        textAnchor="middle"
        fontSize="17"
        fontWeight="700"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        style={props.color ? fillStyle({ color: props.color }) : undefined}
        className={props.color ? (props.dark ? DARK_FILL : FILL) : "fill-muted-foreground"}
      >
        {letter}
      </text>
    </svg>
  );
}

/** A connector's mark at icon size (16 px unless `className` says otherwise); an id the app does not know gets a plug. */
export function ConnectorIcon(props: { id: string; className?: string }) {
  const mark = brandMark(props.id);
  if (mark) {
    if (mark.kind === "ms") return <MicrosoftSquares id={props.id} className={props.className} />;
    if (mark.kind === "letter") return <LetterMark id={props.id} letter={mark.letter} color={mark.color} dark={mark.dark} className={props.className} />;
    return (
      <svg viewBox="0 0 24 24" aria-hidden className={cn("size-4 shrink-0", props.className)} data-connector-icon={props.id}>
        {mark.dark ? <path d={mark.path} style={fillStyle(mark)} className={DARK_FILL} /> : <path fill={mark.color} d={mark.path} />}
      </svg>
    );
  }
  const generic = GENERIC_ICONS[props.id];
  const Icon = generic ?? Plug;
  return <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", props.className)} data-connector-icon={generic ? props.id : "generic"} />;
}

/** The tile every Work list uses: a rounded square with a hairline border and the mark centred. `row` is 28 px (16 px
 *  mark), `chip` 20 px (12 px mark). A custom tool (no id the app knows) shows its first letter. */
export function BrandTile(props: { id?: string | null; name?: string; size?: "row" | "chip"; className?: string }) {
  const chip = props.size === "chip";
  const known = props.id ? brandMark(props.id) || GENERIC_ICONS[props.id] : null;
  return (
    <span
      aria-hidden
      data-brand-tile={props.id ?? "custom"}
      className={cn(
        "flex shrink-0 items-center justify-center border border-border bg-background",
        chip ? "size-5 rounded-[6px]" : "size-7 rounded-lg",
        props.className,
      )}
    >
      {known || !props.name
        ? <ConnectorIcon id={props.id ?? "generic"} className={chip ? "size-3" : "size-4"} />
        : <LetterMark letter={props.name} className={chip ? "size-3" : "size-4"} />}
    </span>
  );
}
