/** @jsxImportSource react */
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useEffect, useRef, useState, type RefObject } from "react";

import type { OmniRushWorkGraphEdge, OmniRushWorkGraphNode } from "@/app/lib/omnirush-server";

import { categoryColor, categoryKey, GRAPH_CATEGORIES, nodeRadius, placeLabels, type LabelBox } from "./graph-model";

type SimNode = OmniRushWorkGraphNode & SimulationNodeDatum & { r: number; key: string };
type SimLink = SimulationLinkDatum<SimNode> & { edge: OmniRushWorkGraphEdge };
type View = { x: number; y: number; k: number };
type Hover = { kind: "node"; node: SimNode; x: number; y: number } | { kind: "edge"; link: SimLink; x: number; y: number } | null;

export type GraphApi = { fit: () => void; zoomBy: (factor: number) => void; centerOn: (id: string) => void };

/** The canvas's own surfaces (the palette was validated against them), edges and label ink per theme. */
export const GRAPH_SURFACE = { dark: "#141413", light: "#fbfbfa" } as const;
const INK = {
  dark: { text: "#ecebe6", halo: "rgba(20,20,19,0.92)", edge: "rgba(236,235,230,0.13)", edgeOn: "rgba(236,235,230,0.62)", ring: "#ecebe6" },
  light: { text: "#1c1c1a", halo: "rgba(251,251,250,0.94)", edge: "rgba(28,28,26,0.14)", edgeOn: "rgba(28,28,26,0.6)", ring: "#1c1c1a" },
};
const KIND_WEIGHT: Record<string, number> = { company: 6, deal: 3, project: 3, product: 2 };
const MIN_K = 0.12;
const MAX_K = 5;
const LABEL_FONT = "500 11.5px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));
const truncate = (text: string, max = 30) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * The force-directed graph on a canvas (smooth at 500 nodes): coloured round nodes with their kind icon, thin edges,
 * labels where they fit. Click selects, right-click (or double-click) expands, drag pins a node, drag the canvas
 * pans, scroll zooms; hover highlights the neighbours and shows a tooltip (an edge's reason on an edge).
 */
export function KnowledgeGraph(props: {
  nodes: OmniRushWorkGraphNode[];
  edges: OmniRushWorkGraphEdge[];
  dark: boolean;
  selected: string | null;
  matches: ReadonlySet<string>;
  onSelect: (id: string | null) => void;
  onExpand: (id: string) => void;
  apiRef?: RefObject<GraphApi | null>;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const iconsRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover>(null);
  // Everything the drawing reads lives in one mutable box: the simulation ticks outside React.
  const state = useRef({
    nodes: [] as SimNode[],
    links: [] as SimLink[],
    byId: new Map<string, SimNode>(),
    near: new Map<string, Set<string>>(),
    view: { x: 0, y: 0, k: 1 } as View,
    size: { width: 0, height: 0 },
    sim: null as Simulation<SimNode, SimLink> | null,
    icons: new Map<string, HTMLImageElement>(),
    hover: null as Hover,
    props,
    frame: 0,
    fitted: false,
    labelWidths: new Map<string, number>(),
    anim: null as { from: View; to: View; start: number } | null,
  });
  state.current.props = props;
  state.current.hover = hover;

  const draw = () => {
    const s = state.current;
    s.frame = 0;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { dark, selected, matches } = s.props;
    const ink = dark ? INK.dark : INK.light;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = s.size;
    const { x, y, k } = s.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = dark ? GRAPH_SURFACE.dark : GRAPH_SURFACE.light;
    ctx.fillRect(0, 0, width, height);

    const focus = s.hover?.kind === "node" ? s.hover.node.id : null;
    const lit = focus ? s.near.get(focus) ?? new Set<string>() : null;
    const picked = selected ? s.near.get(selected) : null;
    // Hover lights a node's neighbourhood; a search lights its matches (and the selection with its neighbours).
    const dimmed = (id: string) => (focus ? id !== focus && !lit!.has(id) : matches.size > 0 && !matches.has(id) && id !== selected && !picked?.has(id));
    const hotEdge = s.hover?.kind === "edge" ? s.hover.link : null;

    ctx.translate(x, y);
    ctx.scale(k, k);
    ctx.lineCap = "round";
    // Edges: thin and quiet; the focused node's (or the selection's) edges in full ink.
    ctx.lineWidth = 1 / k;
    ctx.strokeStyle = ink.edge;
    ctx.beginPath();
    const strong: SimLink[] = [];
    for (const link of s.links) {
      const a = link.source as SimNode;
      const b = link.target as SimNode;
      const on = link === hotEdge || (focus ? a.id === focus || b.id === focus : selected ? a.id === selected || b.id === selected : false);
      if (on) { strong.push(link); continue; }
      if (focus || matches.size) {
        if (dimmed(a.id) || dimmed(b.id)) continue;
      }
      ctx.moveTo(a.x!, a.y!);
      ctx.lineTo(b.x!, b.y!);
    }
    ctx.stroke();
    if (focus || matches.size) {
      // Edges between dimmed nodes, fainter still.
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      for (const link of s.links) {
        const a = link.source as SimNode;
        const b = link.target as SimNode;
        if (strong.includes(link) || !(dimmed(a.id) || dimmed(b.id))) continue;
        ctx.moveTo(a.x!, a.y!);
        ctx.lineTo(b.x!, b.y!);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = ink.edgeOn;
    ctx.lineWidth = 1.4 / k;
    ctx.beginPath();
    for (const link of strong) {
      ctx.moveTo((link.source as SimNode).x!, (link.source as SimNode).y!);
      ctx.lineTo((link.target as SimNode).x!, (link.target as SimNode).y!);
    }
    ctx.stroke();

    // Nodes: a filled circle, a thin surface ring (so overlaps stay readable) and the kind icon.
    const surface = dark ? GRAPH_SURFACE.dark : GRAPH_SURFACE.light;
    for (const node of s.nodes) {
      ctx.globalAlpha = dimmed(node.id) ? 0.2 : 1;
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, node.r, 0, Math.PI * 2);
      ctx.fillStyle = categoryColor(node.key, dark);
      ctx.fill();
      ctx.lineWidth = 1.5 / k;
      ctx.strokeStyle = surface;
      ctx.stroke();
      const icon = s.icons.get(node.key);
      const size = node.r * 1.05;
      if (icon && node.r * k >= 5) ctx.drawImage(icon, node.x! - size / 2, node.y! - size / 2, size, size);
      if (node.id === selected || node.id === focus) {
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, node.r + 3.5 / k, 0, Math.PI * 2);
        ctx.lineWidth = 2 / k;
        ctx.strokeStyle = ink.ring;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // Labels in screen space (constant size): the selected, hovered and matching nodes first, then the biggest,
    // each only where it collides with no label already placed.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = LABEL_FONT;
    const boxes: (LabelBox & { text: string })[] = [];
    for (const node of s.nodes) {
      const sr = node.r * k;
      const sx = node.x! * k + x;
      const sy = node.y! * k + y;
      if (sx < -200 || sx > width + 200 || sy < -40 || sy > height + 40) continue;
      // The hovered node's name is in its tooltip, so it gets no label of its own.
      if (node.id === focus && node.id !== selected) continue;
      const special = node.id === selected ? 4 : matches.has(node.id) ? 2 : (lit ?? picked)?.has(node.id) ? 1 : 0;
      if (!special && (sr < 8.5 || node.type !== "entity" || dimmed(node.id))) continue;
      const text = truncate(node.label);
      let textWidth = s.labelWidths.get(text);
      if (textWidth === undefined) { textWidth = ctx.measureText(text).width; s.labelWidths.set(text, textWidth); }
      // Companies, deals and projects before people when room is short.
      const priority = special * 1000 + sr + (node.type === "entity" ? KIND_WEIGHT[node.kind] ?? 0 : 0);
      // Below the node first, then above, then to the right.
      boxes.push(
        { id: node.id, text, x: sx - textWidth / 2, y: sy + sr + 3, width: textWidth, height: 14, priority },
        { id: node.id, text, x: sx - textWidth / 2, y: sy - sr - 17, width: textWidth, height: 14, priority },
        { id: node.id, text, x: sx + sr + 5, y: sy - 7, width: textWidth, height: 14, priority },
      );
    }
    // Nodes block labels too, so a label never covers one (only specks too small to matter are skipped).
    const discs: LabelBox[] = s.nodes.filter((node) => node.r * k >= 4).map((node) => ({ id: node.id, x: node.x! * k + x - node.r * k, y: node.y! * k + y - node.r * k, width: node.r * k * 2, height: node.r * k * 2, priority: 0 }));
    // The selected, hovered and matching nodes' labels always show; the rest only where they fit around them.
    // (Clear of other nodes where possible; anywhere else they would leave the view, never.)
    const inView = boxes.filter((box) => box.x >= 2 && box.x + box.width <= width - 2 && box.y >= 2 && box.y + box.height <= height - 2);
    const specials = inView.filter((box) => box.priority >= 2000);
    const first = placeLabels(specials, 2, discs);
    for (const [id, box] of placeLabels(specials.filter((box) => !first.has(box.id)), 2, [...first.values()])) first.set(id, box);
    const rest = placeLabels(inView.filter((box) => box.priority < 2000), 2, [...discs, ...first.values()]);
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    for (const box of [...first.values(), ...rest.values()]) {
      ctx.globalAlpha = dimmed(box.id) ? 0.35 : 1;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = ink.halo;
      ctx.strokeText(box.text, box.x, box.y);
      ctx.fillStyle = ink.text;
      ctx.fillText(box.text, box.x, box.y);
    }
    ctx.globalAlpha = 1;
  };

  const schedule = () => {
    const s = state.current;
    if (!s.frame) s.frame = requestAnimationFrame(draw);
  };

  const animateView = (to: View) => {
    const s = state.current;
    const anim = { from: { ...s.view }, to, start: performance.now() };
    s.anim = anim;
    const step = (now: number) => {
      if (s.anim !== anim) return;
      const t = Math.min(1, (now - anim.start) / 320);
      const e = 1 - (1 - t) ** 3;
      s.view = { x: anim.from.x + (anim.to.x - anim.from.x) * e, y: anim.from.y + (anim.to.y - anim.from.y) * e, k: anim.from.k + (anim.to.k - anim.from.k) * e };
      draw();
      if (t < 1) requestAnimationFrame(step);
      else s.anim = null;
    };
    requestAnimationFrame(step);
  };

  const fitView = (): View => {
    const s = state.current;
    const { width, height } = s.size;
    if (!s.nodes.length || !width) return s.view;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of s.nodes) {
      minX = Math.min(minX, node.x! - node.r);
      maxX = Math.max(maxX, node.x! + node.r);
      minY = Math.min(minY, node.y! - node.r);
      maxY = Math.max(maxY, node.y! + node.r + 18);
    }
    // 64 px clear at the top for the count and hint overlays.
    const k = clampK(Math.min(1.6, Math.min((width - 80) / Math.max(1, maxX - minX), (height - 120) / Math.max(1, maxY - minY))));
    return { k, x: width / 2 - ((minX + maxX) / 2) * k, y: 32 + height / 2 - ((minY + maxY) / 2) * k };
  };

  if (props.apiRef) {
    props.apiRef.current = {
      fit: () => animateView(fitView()),
      zoomBy: (factor) => {
        const { view, size } = state.current;
        const k = clampK(view.k * factor);
        animateView({ k, x: size.width / 2 - ((size.width / 2 - view.x) * k) / view.k, y: size.height / 2 - ((size.height / 2 - view.y) * k) / view.k });
      },
      centerOn: (id) => {
        const { byId, view, size } = state.current;
        const node = byId.get(id);
        if (node) animateView({ k: view.k, x: size.width / 2 - node.x! * view.k, y: size.height / 2 - node.y! * view.k });
      },
    };
  }

  // The kind icons as images (white strokes), drawn inside every node.
  useEffect(() => {
    const s = state.current;
    for (const svg of iconsRef.current?.querySelectorAll("svg[data-graph-icon]") ?? []) {
      const key = svg.getAttribute("data-graph-icon")!;
      const image = new Image();
      image.onload = schedule;
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`;
      s.icons.set(key, image);
    }
  }, []);

  // Size the canvas to its box (sharp on high-density screens).
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const observer = new ResizeObserver(() => {
      const s = state.current;
      const dpr = window.devicePixelRatio || 1;
      // Keep the middle of the view in the middle when the box changes (the inspector opens or closes).
      if (s.size.width) {
        const shift = (view: View) => ({ ...view, x: view.x + (wrap.clientWidth - s.size.width) / 2, y: view.y + (wrap.clientHeight - s.size.height) / 2 });
        s.view = shift(s.view);
        if (s.anim) { s.anim.from = shift(s.anim.from); s.anim.to = shift(s.anim.to); }
      }
      s.size = { width: wrap.clientWidth, height: wrap.clientHeight };
      canvas.width = Math.round(s.size.width * dpr);
      canvas.height = Math.round(s.size.height * dpr);
      if (!s.fitted && s.nodes.length) { s.view = fitView(); s.fitted = true; }
      draw();
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // New data: keep known nodes where they are, start new ones beside a neighbour that is already placed.
  useEffect(() => {
    const s = state.current;
    const before = s.byId;
    const fresh = before.size === 0;
    const byId = new Map<string, SimNode>();
    const near = new Map<string, Set<string>>();
    for (const edge of props.edges) {
      near.set(edge.a, (near.get(edge.a) ?? new Set()).add(edge.b));
      near.set(edge.b, (near.get(edge.b) ?? new Set()).add(edge.a));
    }
    const nodes = props.nodes.map((node) => {
      const old = before.get(node.id);
      const next: SimNode = Object.assign(old ?? {}, node, { r: nodeRadius(node), key: categoryKey(node) });
      byId.set(node.id, next);
      return next;
    });
    // The rest start where d3 puts them (a fixed spiral), so the same data opens with the same layout.
    nodes.forEach((node, index) => {
      if (node.x !== undefined) return;
      const anchor = [...(near.get(node.id) ?? [])].map((id) => before.get(id)).find((other) => other?.x !== undefined);
      if (!anchor) return;
      const angle = index * 2.399963;
      node.x = anchor.x! + Math.cos(angle) * 30;
      node.y = anchor.y! + Math.sin(angle) * 30;
    });
    const links: SimLink[] = props.edges.filter((edge) => byId.has(edge.a) && byId.has(edge.b)).map((edge) => ({ source: edge.a, target: edge.b, edge }));
    s.nodes = nodes;
    s.byId = byId;
    s.near = near;
    s.sim?.stop();
    const sim = forceSimulation<SimNode, SimLink>(nodes)
      .force("link", forceLink<SimNode, SimLink>(links).id((node) => node.id)
        .distance((link) => {
          const a = link.source as SimNode;
          const b = link.target as SimNode;
          return a.type === "entity" && b.type === "entity" ? 110 + a.r + b.r : 34 + a.r + b.r;
        })
        .strength((link) => 0.9 / Math.min(near.get((link.source as SimNode).id)?.size ?? 1, near.get((link.target as SimNode).id)?.size ?? 1)))
      .force("charge", forceManyBody<SimNode>().strength((node) => (node.type === "entity" ? -160 - node.r * 10 : -14)).distanceMax(900).theta(0.9))
      .force("collide", forceCollide<SimNode>((node) => (node.type === "entity" ? node.r + 18 : node.r + 3)).iterations(2))
      .force("x", forceX<SimNode>(0).strength(0.03))
      .force("y", forceY<SimNode>(0).strength(0.03))
      .on("tick", schedule)
      .stop();
    s.links = links;
    s.sim = sim;
    if (fresh) {
      // Settle before the first paint so the overview opens calm, not exploding.
      sim.alpha(1);
      for (let i = 0; i < 260; i += 1) sim.tick();
      s.view = fitView();
      s.fitted = s.size.width > 0;
      draw();
      sim.alpha(0.05).alphaTarget(0).restart();
    } else {
      sim.alpha(0.5).restart();
    }
    return () => { sim.stop(); };
  }, [props.nodes, props.edges]);

  useEffect(schedule, [props.dark, props.selected, props.matches, hover]);

  const toWorld = (event: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const { x, y, k } = state.current.view;
    const sx = event.clientX - rect.left;
    const sy = event.clientY - rect.top;
    return { sx, sy, wx: (sx - x) / k, wy: (sy - y) / k };
  };
  const nodeAt = (wx: number, wy: number): SimNode | null => {
    const { nodes, view } = state.current;
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i]!;
      if (Math.hypot(node.x! - wx, node.y! - wy) <= node.r + 3 / view.k) return node;
    }
    return null;
  };
  const edgeAt = (sx: number, sy: number): SimLink | null => {
    const { links, view } = state.current;
    let best: SimLink | null = null;
    let bestDistance = 4;
    for (const link of links) {
      const a = link.source as SimNode;
      const b = link.target as SimNode;
      const distance = segmentDistance(sx, sy, a.x! * view.k + view.x, a.y! * view.k + view.y, b.x! * view.k + view.x, b.y! * view.k + view.y);
      if (distance < bestDistance) { best = link; bestDistance = distance; }
    }
    return best;
  };

  const drag = useRef<{ node: SimNode | null; startX: number; startY: number; viewX: number; viewY: number; moved: boolean } | null>(null);

  return (
    <div ref={wrapRef} className="relative size-full overflow-hidden" data-testid="work-graph-canvas">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 size-full touch-none"
        style={{ cursor: hover?.kind === "node" ? "pointer" : drag.current ? "grabbing" : "grab" }}
        role="img"
        aria-label={`Knowledge graph: ${props.nodes.length} items. The list view shows the same items as a list.`}
        onPointerDown={(event) => {
          const { sx, sy, wx, wy } = toWorld(event);
          const node = nodeAt(wx, wy);
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { node, startX: sx, startY: sy, viewX: state.current.view.x, viewY: state.current.view.y, moved: false };
          if (node) { node.fx = node.x; node.fy = node.y; }
        }}
        onPointerMove={(event) => {
          const { sx, sy, wx, wy } = toWorld(event);
          const current = drag.current;
          if (current) {
            if (!current.moved && Math.hypot(sx - current.startX, sy - current.startY) < 3) return;
            current.moved = true;
            setHover(null);
            if (current.node) {
              current.node.fx = wx;
              current.node.fy = wy;
              state.current.sim?.alphaTarget(0.12).restart();
            } else {
              state.current.view = { ...state.current.view, x: current.viewX + sx - current.startX, y: current.viewY + sy - current.startY };
              schedule();
            }
            return;
          }
          const node = nodeAt(wx, wy);
          if (node) { setHover({ kind: "node", node, x: sx, y: sy }); return; }
          const link = edgeAt(sx, sy);
          setHover(link ? { kind: "edge", link, x: sx, y: sy } : null);
        }}
        onPointerUp={() => {
          const current = drag.current;
          drag.current = null;
          state.current.sim?.alphaTarget(0);
          if (!current) return;
          // A dragged node stays pinned where it was dropped; a click selects (or, on the canvas, clears).
          if (!current.moved) {
            if (current.node) { current.node.fx = null; current.node.fy = null; }
            props.onSelect(current.node?.id ?? null);
          }
        }}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={(event) => {
          const { wx, wy } = toWorld(event);
          const node = nodeAt(wx, wy);
          if (node) props.onExpand(node.id);
        }}
        onContextMenu={(event) => {
          const { wx, wy } = toWorld(event);
          const node = nodeAt(wx, wy);
          if (!node) return;
          event.preventDefault();
          props.onSelect(node.id);
          props.onExpand(node.id);
        }}
        onWheel={(event) => {
          const { sx, sy } = toWorld(event);
          const view = state.current.view;
          const k = clampK(view.k * Math.exp(-event.deltaY * 0.0015));
          state.current.view = { k, x: sx - ((sx - view.x) * k) / view.k, y: sy - ((sy - view.y) * k) / view.k };
          schedule();
        }}
      />
      {hover ? <GraphTooltip hover={hover} /> : null}
      <div ref={iconsRef} hidden aria-hidden>
        {GRAPH_CATEGORIES.map((category) => <category.icon key={category.key} data-graph-icon={category.key} color="#ffffff" strokeWidth={2.4} size={48} />)}
      </div>
    </div>
  );
}

function GraphTooltip(props: { hover: NonNullable<Hover> }) {
  const { hover } = props;
  const style = { left: hover.x + 14, top: hover.y + 14 };
  const box = "pointer-events-none absolute z-10 max-w-72 rounded-lg border border-border bg-popover px-3 py-2 text-[12px] text-popover-foreground shadow-lg";
  if (hover.kind === "edge") {
    const a = hover.link.source as SimNode;
    const b = hover.link.target as SimNode;
    return (
      <div className={box} style={style} data-testid="work-graph-tooltip">
        <div className="font-medium">{hover.link.edge.reason || hover.link.edge.kind}</div>
        <div className="mt-0.5 truncate text-muted-foreground">{truncate(a.label, 24)} ↔ {truncate(b.label, 24)}</div>
      </div>
    );
  }
  const node = hover.node;
  const at = node.occurred_at ? new Date(node.occurred_at) : null;
  return (
    <div className={box} style={style} data-testid="work-graph-tooltip">
      <div className="font-medium">{node.label}</div>
      <div className="mt-0.5 text-muted-foreground">{[node.kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), node.sub, at && !Number.isNaN(at.getTime()) ? at.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null].filter(Boolean).join(" · ")}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{node.degree} link{node.degree === 1 ? "" : "s"} · right-click to expand</div>
    </div>
  );
}
