// One line of chips that never wraps: how many fit beside a trailing "+N" or More button. A hidden copy of the row
// (the probe) gives each chip's own width; the visible row then shows as many as fit and the rest go behind the button.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** The gap between chips on the row (Tailwind gap-1.5). */
export const ROW_GAP = 6;

/**
 * How many of the first items fit on one line. All of them when they fit without the trailing button; else as many
 * as fit beside it, never fewer than `pinned` (chips that always show) or one, never more than `max`. An unmeasured
 * row (no width yet, or a test DOM without layout) shows everything up to `max`.
 */
export function fitCount(input: { widths: readonly number[]; available: number; gap?: number; more: number; pinned?: number; max?: number }): number {
  const { widths, available, more } = input;
  const gap = input.gap ?? ROW_GAP;
  const cap = Math.min(widths.length, input.max ?? widths.length);
  if (cap === 0) return 0;
  if (!(available > 0) || widths.every((width) => !(width > 0))) return cap;
  const span = (count: number) => widths.slice(0, count).reduce((sum, width) => sum + width, 0) + gap * Math.max(0, count - 1);
  if (cap === widths.length && span(cap) <= available + 0.5) return cap;
  let count = cap;
  while (count > 0 && span(count) + gap + more > available + 0.5) count -= 1;
  return Math.min(cap, Math.max(count, input.pinned ?? 0, 1));
}

/**
 * The fit for a row: `row` is the visible line (its content width is the room), `probe` is the hidden line with one
 * child per item, then the trailing button, each at its own width. Re-measures when `signature` changes and when fonts
 * load; the row's width is watched.
 */
export function useFitCount(options: { count: number; signature: string; pinned?: number; max?: number }) {
  const { count, signature, pinned, max } = options;
  const row = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const widths = useRef<number[]>([]);
  const more = useRef(0);
  const [fit, setFit] = useState(() => Math.min(count, max ?? count));

  const compute = useCallback(() => {
    const element = row.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const available = element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const next = fitCount({ widths: widths.current, available, more: more.current, pinned, max });
    setFit((current) => (current === next ? current : next));
  }, [max, pinned]);

  const measure = useCallback(() => {
    const children = Array.from(probe.current?.children ?? []) as HTMLElement[];
    widths.current = children.slice(0, count).map((child) => child.getBoundingClientRect().width);
    more.current = children[count]?.getBoundingClientRect().width ?? 0;
    compute();
  }, [compute, count]);

  useLayoutEffect(() => {
    measure();
  }, [measure, signature]);

  useEffect(() => {
    const element = row.current;
    if (!element) return;
    let cancelled = false;
    void document.fonts?.ready.then(() => { if (!cancelled) measure(); });
    if (typeof ResizeObserver === "undefined") return () => { cancelled = true; };
    const observer = new ResizeObserver(() => compute());
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [compute, measure]);

  return { fit: Math.min(fit, count), row, probe };
}

/** The probe's wrapper: laid out at the chips' own widths, never seen, focused or read. */
export const PROBE_CLASS = "pointer-events-none invisible absolute start-0 top-0 h-0 w-0 overflow-hidden";
export const PROBE_ROW_CLASS = "flex w-max items-center gap-1.5";
