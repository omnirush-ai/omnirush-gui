import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  asPlacement,
  dismissPlacement,
  endTurnFooter,
  loadHomePlacement,
  loadTurnFooter,
  homeCardMounted,
  explainPlacement,
  openPlacement,
  placementActivity,
  placementConversation,
  placementRendered,
  placementViewable,
  placementViewableSent,
  reportPlacement,
  setPlacementsBridgeForTests,
  turnJustFinished,
  usePlacementsStore,
} from "../src/app/lib/placements";
import { PlacementHomeCard, PlacementHomeCardView, PlacementTurnFooter, PlacementTurnFooterView } from "../src/react-app/domains/placements/placements";

const DISPLAY = "3f2b6c1e-8a4d-4f7b-9c2e-1d5a6b7c8d9e";
const PLACEMENT = {
  id: "plc_abc",
  displayId: DISPLAY,
  surface: "desktop_home",
  slot: "home_banner",
  label: "Sponsored · Acme",
  sponsor: "Acme",
  title: "Fast CI for your repo",
  body: "Run your tests in half the time.",
  ctaLabel: "Try it",
  url: "https://acme.example/ci",
  imageUrl: null,
  domain: "acme.example",
  snoozeDays: 7,
};

function fakeMain(answer: unknown = PLACEMENT) {
  const asks: unknown[] = [];
  const actions: Record<string, unknown>[] = [];
  let rotate = false;
  setPlacementsBridgeForTests({
    placement: async (input) => {
      asks.push(input);
      return typeof answer === "function" ? (answer as (i: unknown) => unknown)(input) : answer;
    },
    action: async (input) => {
      actions.push(input);
      return { ok: true, rotate };
    },
  });
  return { asks, actions, setRotate: (v: boolean) => { rotate = v; } };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => setPlacementsBridgeForTests(null));

describe("placements: what the window accepts", () => {
  test("a placement from the main process", () => {
    expect(asPlacement(PLACEMENT)?.label).toBe("Sponsored · Acme");
  });

  test("the domain: as sent, else the link's host (older main processes)", () => {
    expect(asPlacement({ ...PLACEMENT, domain: "acme.cloud" })?.domain).toBe("acme.cloud");
    expect(asPlacement({ ...PLACEMENT, domain: undefined, url: "https://www.acme.example/x" })?.domain).toBe("acme.example");
  });

  test("the label is always Sponsored · sponsor", () => {
    expect(asPlacement({ ...PLACEMENT, label: "Recommended" })?.label).toBe("Sponsored · Acme");
  });

  test("anything else is nothing", () => {
    for (const bad of [
      null,
      "x",
      { ...PLACEMENT, url: "http://acme.example" },
      { ...PLACEMENT, url: "javascript:alert(1)" },
      { ...PLACEMENT, imageUrl: "http://acme.example/a.png" },
      { ...PLACEMENT, slot: "modal" },
      { ...PLACEMENT, title: "" },
      { ...PLACEMENT, title: "T".repeat(61) },
      { ...PLACEMENT, body: "B".repeat(141) },
      { ...PLACEMENT, ctaLabel: "C".repeat(21) },
      { ...PLACEMENT, sponsor: "" },
      { ...PLACEMENT, displayId: undefined },
      { ...PLACEMENT, displayId: "not-a-uuid" },
      { ...PLACEMENT, surface: "cli_home" },
      { ...PLACEMENT, surface: "desktop_turn" },
    ]) {
      expect(asPlacement(bad)).toBeNull();
    }
  });
});

describe("placements: the home card", () => {
  test("nothing before an answer, and nothing for a null answer", async () => {
    fakeMain(null);
    expect(renderToStaticMarkup(<PlacementHomeCard />)).toBe("");
    await loadHomePlacement();
    expect(usePlacementsStore.getState().home).toBeNull();
    expect(renderToStaticMarkup(<PlacementHomeCard />)).toBe("");
  });

  test("a failing main process is nothing too", async () => {
    setPlacementsBridgeForTests({ placement: async () => { throw new Error("no handler"); }, action: async () => ({ ok: false }) });
    expect(await loadHomePlacement()).toBeNull();
    expect(renderToStaticMarkup(<PlacementHomeCard />)).toBe("");
  });

  test("labelled, letter mark, title, body, CTA, domain, … and ×; plain text, no motion", async () => {
    const { asks } = fakeMain();
    await loadHomePlacement();
    const first = usePlacementsStore.getState().home;
    await loadHomePlacement();
    expect(asks).toEqual([{ slot: "home_banner" }, { slot: "home_banner" }]);
    const placement = usePlacementsStore.getState().home!;
    expect(placement).toBe(first!);
    expect(placement.displayId).toBe(DISPLAY);
    expect(placement.title).toBe("Fast CI for your repo");
    const html = renderToStaticMarkup(<PlacementHomeCardView placement={placement} />);
    expect(html).toContain('data-testid="placement-home"');
    expect(html).toContain(`data-display-id="${DISPLAY}"`);
    expect(html).toContain('aria-label="Sponsored · Acme"');
    expect(html).toContain(">Sponsored</span>");
    expect(html).toContain("Fast CI for your repo");
    expect(html).toContain("Run your tests in half the time.");
    expect(html).toContain("Try it");
    expect(html).toContain('data-testid="placement-home-letter"');
    expect(html).toContain('aria-label="Hide this sponsored message"');
    expect(html).toContain('aria-label="Sponsored message options"');
    expect(html).toContain('aria-label="Open acme.example"');
    expect(html).not.toMatch(/animate-|transition|<a /);
    expect(html).not.toContain("<img");
    // The domain is text only: the link is never in the page, the main process opens it on a click.
    expect(html).not.toContain("acme.example/ci");
  });

  test("an https image only when there is one", async () => {
    fakeMain({ ...PLACEMENT, imageUrl: "https://acme.example/logo.png" });
    const placement = await loadHomePlacement();
    const html = renderToStaticMarkup(<PlacementHomeCardView placement={placement!} />);
    expect(html).toContain('src="https://acme.example/logo.png"');
    expect(html).toMatch(/referrerpolicy="no-referrer"/i);
  });

  test("rendered and viewable once per display, click and × with the same display id", async () => {
    const { actions } = fakeMain();
    const placement = await loadHomePlacement();
    placementRendered(placement!);
    placementRendered(placement!);
    expect(placementViewableSent(placement!)).toBe(false);
    placementViewable(placement!);
    placementViewable(placement!);
    expect(placementViewableSent(placement!)).toBe(true);
    openPlacement(placement!);
    dismissPlacement(placement!);
    dismissPlacement(placement!);
    await flush();
    expect(actions).toEqual([
      { action: "rendered", id: "plc_abc", displayId: DISPLAY },
      { action: "viewable", id: "plc_abc", displayId: DISPLAY },
      { action: "open", id: "plc_abc", displayId: DISPLAY },
      { action: "dismiss", id: "plc_abc", displayId: DISPLAY },
    ]);
    expect(usePlacementsStore.getState().home).toBeNull();
  });

  test("the menu: why opens the measurement page (main process), report is counted and hides it", async () => {
    const { actions } = fakeMain();
    const placement = await loadHomePlacement();
    explainPlacement();
    reportPlacement(placement!);
    reportPlacement(placement!);
    await flush();
    expect(actions).toEqual([{ action: "why" }, { action: "report", id: "plc_abc", displayId: DISPLAY }]);
    expect(usePlacementsStore.getState().home).toBeNull();
  });

  test("a new display id is a new display: its own rendered and viewable", async () => {
    const second = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    let n = 0;
    const { actions } = fakeMain(() => ({ ...PLACEMENT, displayId: n++ === 0 ? DISPLAY : second }));
    const a = await loadHomePlacement();
    placementRendered(a!);
    placementViewable(a!);
    const b = await loadHomePlacement();
    expect(usePlacementsStore.getState().home?.displayId).toBe(second);
    placementRendered(b!);
    placementViewable(b!);
    await flush();
    expect(actions.map((x) => `${x.action}:${x.displayId}`)).toEqual([`rendered:${DISPLAY}`, `viewable:${DISPLAY}`, `rendered:${second}`, `viewable:${second}`]);
  });
});

describe("placements: the display rotation signals", () => {
  test("a turn starting tells the main process once per conversation", async () => {
    const { actions } = fakeMain();
    placementConversation("ses_1");
    placementConversation("ses_1");
    placementConversation("ses_2");
    await flush();
    expect(actions).toEqual([{ action: "conversation", sessionId: "ses_1" }, { action: "conversation", sessionId: "ses_2" }]);
  });

  test("activity at most once a minute", async () => {
    const { actions } = fakeMain();
    placementActivity(1_000_000);
    placementActivity(1_030_000);
    placementActivity(1_061_000);
    await flush();
    expect(actions).toEqual([{ action: "activity" }, { action: "activity" }]);
  });

  test("a due rotation asks again only while the home card is on screen", async () => {
    const { asks, setRotate } = fakeMain();
    setRotate(true);
    placementActivity(5_000_000);
    await flush();
    await flush();
    expect(asks.length).toBe(0);
    const unmount = homeCardMounted();
    placementActivity(5_100_000);
    await flush();
    await flush();
    expect(asks).toEqual([{ slot: "home_banner" }]);
    unmount();
  });
});

describe("placements: the turn card", () => {
  test("only on the running → done edge of the same session", () => {
    expect(turnJustFinished({ sessionId: "a", running: true }, { sessionId: "a", running: false })).toBe(true);
    expect(turnJustFinished({ sessionId: "a", running: false }, { sessionId: "a", running: false })).toBe(false);
    expect(turnJustFinished({ sessionId: "a", running: true }, { sessionId: "b", running: false })).toBe(false);
    expect(turnJustFinished({ sessionId: "a", running: false }, { sessionId: "a", running: true })).toBe(false);
  });

  test("asked once per session, drawn only while no turn runs, gone when the next turn starts", async () => {
    const { asks } = fakeMain({ ...PLACEMENT, slot: "turn_footer", surface: "desktop_turn" });
    await loadTurnFooter("ses_1");
    await loadTurnFooter("ses_1");
    expect(asks).toEqual([{ slot: "turn_footer", sessionId: "ses_1" }]);
    const placement = usePlacementsStore.getState().footers.ses_1!;
    const line = renderToStaticMarkup(<PlacementTurnFooterView placement={placement} />);
    expect(line).toContain('data-testid="placement-turn-footer"');
    expect(line).toContain("Sponsored · Acme");
    expect(line).toContain('data-testid="placement-turn-footer-domain"');
    expect(line).toContain('data-testid="placement-turn-footer-menu"');
    expect(line).not.toMatch(/animate-|transition|<a /);
    // While a turn runs: nothing (the container's rule, before any state).
    expect(renderToStaticMarkup(<PlacementTurnFooter sessionId="ses_1" turnRunning />)).toBe("");
    expect(usePlacementsStore.getState().footers.ses_2).toBeUndefined();
    endTurnFooter("ses_1");
    expect(usePlacementsStore.getState().footers.ses_1).toBeNull();
    await loadTurnFooter("ses_1");
    expect(asks.length).toBe(1);
  });

  test("none from the main process: nothing", async () => {
    fakeMain(null);
    await loadTurnFooter("ses_1");
    expect(usePlacementsStore.getState().footers.ses_1).toBeNull();
    expect(renderToStaticMarkup(<PlacementTurnFooter sessionId="ses_1" turnRunning={false} />)).toBe("");
  });
});
