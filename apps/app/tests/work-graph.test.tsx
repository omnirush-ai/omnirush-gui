import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  categoryColor, categoryCounts, categoryKey, entityIdOf, GRAPH_CATEGORIES, GRAPH_PALETTE, groupByDay, matchNodes, mergeGraph, nodeRadius, placeLabels, visibleGraph,
} from "../src/react-app/domains/work/graph-model";
import { CategoryPanel, NodeCard } from "../src/react-app/domains/work/knowledge-views";
import { fullWorkGraph, workGraphAnswer, workTimelineAnswer } from "./fixtures/work-graph";

const full = fullWorkGraph();

describe("Work graph explorer", () => {
  test("the fixture has the contract's shape: about 300 nodes in the overview, ids e:/r:/f:, edges between known nodes", () => {
    const overview = workGraphAnswer(full);
    expect(overview.nodes.length).toBe(300);
    expect(overview.truncated).toBe(true);
    const ids = new Set(overview.nodes.map((node) => node.id));
    expect(overview.nodes.every((node) => /^[erf]:/.test(node.id))).toBe(true);
    expect(overview.edges.every((edge) => ids.has(edge.a) && ids.has(edge.b))).toBe(true);
  });

  test("every node falls into a known category; unknown kinds into their group's other", () => {
    expect(categoryKey({ type: "entity", kind: "person" })).toBe("entity:person");
    expect(categoryKey({ type: "entity", kind: "vendor" })).toBe("entity:other");
    expect(categoryKey({ type: "record", kind: "deal" })).toBe("record:contact");
    expect(categoryKey({ type: "record", kind: "fax" })).toBe("record:other");
    expect(categoryKey({ type: "fact", kind: "rumour" })).toBe("fact:fact");
    const keys = new Set(GRAPH_CATEGORIES.map((category) => category.key));
    expect(full.nodes.every((node) => keys.has(categoryKey(node)))).toBe(true);
  });

  test("one palette for nodes and legend, light and dark: entity kinds a hue each, records and knowledge one each", () => {
    expect(GRAPH_PALETTE.light.length).toBe(GRAPH_PALETTE.dark.length);
    expect(categoryColor("entity:person", false)).toBe(GRAPH_PALETTE.light[0]);
    expect(categoryColor("entity:person", true)).toBe(GRAPH_PALETTE.dark[0]);
    const entityHues = new Set(["person", "company", "deal", "project", "product"].map((kind) => categoryColor(`entity:${kind}`, true)));
    expect(entityHues.size).toBe(5);
    expect(categoryColor("record:email", true)).toBe(categoryColor("record:invoice", true));
    expect(categoryColor("fact:policy", true)).not.toBe(categoryColor("record:email", true));
  });

  test("expanding merges the neighbourhood: nodes once, edges once in either direction, overview counts kept", () => {
    const overview = workGraphAnswer(full);
    const hidden = full.nodes.find((node) => !overview.nodes.some((item) => item.id === node.id))!;
    const owner = full.edges.find((edge) => edge.a === hidden.id || edge.b === hidden.id)!;
    const focus = owner.a === hidden.id ? owner.b : owner.a;
    const merged = mergeGraph(overview, workGraphAnswer(full, { focus }));
    expect(merged.nodes.some((node) => node.id === hidden.id)).toBe(true);
    expect(new Set(merged.nodes.map((node) => node.id)).size).toBe(merged.nodes.length);
    const again = mergeGraph(merged, { nodes: [], edges: merged.edges.map((edge) => ({ ...edge, a: edge.b, b: edge.a })), counts: {}, truncated: false });
    expect(again.edges.length).toBe(merged.edges.length);
    expect(merged.counts).toBe(overview.counts);
  });

  test("hidden categories drop their nodes and every edge that touches them", () => {
    const shown = visibleGraph(full, new Set(["entity:person"]));
    expect(shown.nodes.some((node) => categoryKey(node) === "entity:person")).toBe(false);
    const ids = new Set(shown.nodes.map((node) => node.id));
    expect(shown.edges.every((edge) => ids.has(edge.a) && ids.has(edge.b))).toBe(true);
  });

  test("counts: the server's totals per category, else the loaded nodes", () => {
    const counts = categoryCounts({ nodes: [], counts: { "entity:person": 3, "record:deal": 2, "record:contact": 1, "record:fax": 4 } });
    expect(counts.get("entity:person")).toBe(3);
    expect(counts.get("record:contact")).toBe(3);
    expect(counts.get("record:other")).toBe(4);
    expect(categoryCounts({ nodes: full.nodes.slice(0, 2), counts: {} }).size).toBeGreaterThan(0);
  });

  test("labels never overlap each other or a blocked box; the higher priority wins; a label takes its next spot when the first is taken", () => {
    const placed = placeLabels([
      { id: "small", x: 0, y: 0, width: 50, height: 14, priority: 1 },
      { id: "big", x: 10, y: 5, width: 50, height: 14, priority: 9 },
      { id: "far", x: 200, y: 0, width: 50, height: 14, priority: 1 },
      { id: "onNode", x: 400, y: 0, width: 50, height: 14, priority: 5 },
    ], 2, [{ id: "disc", x: 420, y: 4, width: 10, height: 10, priority: 0 }]);
    expect([...placed.keys()].sort()).toEqual(["big", "far"]);
    const moved = placeLabels([
      { id: "a", x: 0, y: 20, width: 50, height: 14, priority: 1 },
      { id: "a", x: 0, y: -20, width: 50, height: 14, priority: 1 },
    ], 2, [{ id: "disc", x: 0, y: 18, width: 10, height: 10, priority: 0 }]);
    expect(moved.get("a")?.y).toBe(-20);
  });

  test("big entities, small records; search matches every word; entity ids map to the entity routes", () => {
    expect(nodeRadius({ type: "entity", degree: 40 })).toBeGreaterThan(nodeRadius({ type: "entity", degree: 1 }));
    expect(nodeRadius({ type: "entity", degree: 10_000 })).toBe(24);
    expect(nodeRadius({ type: "record", degree: 50 })).toBe(7);
    const company = full.nodes.find((node) => node.kind === "company")!;
    expect(matchNodes(full.nodes, company.label.toUpperCase()).has(company.id)).toBe(true);
    expect(matchNodes(full.nodes, "").size).toBe(0);
    expect(entityIdOf("e:ent_42")).toBe("ent_42");
    expect(entityIdOf("r:7")).toBeNull();
  });

  test("timeline: newest day first, undated last, the server's order kept within a day", () => {
    const days = groupByDay([
      { id: "a", occurred_at: "2026-11-12T15:00:00" },
      { id: "b", occurred_at: "2026-11-13T09:00:00" },
      { id: "c", occurred_at: null },
      { id: "d", occurred_at: "2026-11-12T08:00:00" },
    ]);
    expect(days.map((day) => day.day)).toEqual(["2026-11-13", "2026-11-12", ""]);
    expect(days[1]!.items.map((item) => item.id)).toEqual(["a", "d"]);
    const page = workTimelineAnswer(full, { limit: 20 });
    expect(page.items.length).toBe(20);
    expect(page.items.every((item) => !item.id.startsWith("e:"))).toBe(true);
  });

  test("the category panel lists only present categories with counts and a show/hide toggle; a record card links to its source", () => {
    const markup = renderToStaticMarkup(<CategoryPanel counts={categoryCounts(full)} hidden={new Set(["record:email"])} dark onToggle={() => {}} />);
    expect(markup).toContain("Entities");
    expect(markup).toContain("Knowledge");
    expect(markup).toMatch(/aria-pressed="false"[^>]*data-graph-category="record:email"/);
    expect(markup).toMatch(/aria-pressed="true"[^>]*data-graph-category="entity:person"/);
    expect(markup).not.toContain('data-graph-category="record:pull_request"');
    const record = full.nodes.find((node) => node.type === "record")!;
    expect(renderToStaticMarkup(<NodeCard node={record} dark={false} openLink={() => {}} />)).toContain("Open at the source");
  });
});
