import type { Seed } from "@omnirush/env";

export async function emptySession(seed: Seed) {
  const workspacePath = seed.tmpPath("empty-session");
  const app = await seed.desktop({ name: "empty-session" });
  const workspace = await seed.workspace(app, workspacePath);
  const session = await seed.session(app);
  return { app, workspace, session, workspacePath };
}
