import { waitFor } from "@omnirush/behaviors";
import { org } from "../seed.ts";
import { webTab } from "../surfaces.ts";
import { shot } from "./shot.ts";

const browser = webTab({ org });

async function waitForOmniRushWeb(surface: Awaited<ReturnType<typeof browser.load>>): Promise<void> {
  await waitFor(surface, () => (Boolean(window.__omnirushControl)), {
    timeoutMs: 120_000,
    label: "OmniRush.ai Web booted",
  });
  await waitFor(surface, () => (document.body.innerText.includes("acme-robotics")
    && document.body.innerText.includes("Describe your task")
    && !document.body.innerText.includes("Pulling in the latest messages")), {
    timeoutMs: 120_000,
    label: "OmniRush.ai Web settled on the demo workspace",
  });
}

export const omnirushWebTab = shot("omnirush-web-tab", {
  use: browser,
  at: "/",
  steps: [waitForOmniRushWeb],
  expect: ["acme-robotics", "What do you need done?"],
  never: ["Something went wrong", "Unable to connect", "docs-3959-screenshots"],
  out: "packages/docs/images/omnirush-web-browser-tab.png",
});
