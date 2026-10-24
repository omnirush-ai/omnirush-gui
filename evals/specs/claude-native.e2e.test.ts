import { expect } from "vitest";
import { spec } from "@omnirush/testkit";
import { claudeNativeWorld, claudeConnectionWorld } from "../worlds/claude-native.ts";
const test = spec.world(claudeNativeWorld, {needs: {placement: "local", commands: ["bun", "docker", "pnpm"]}, timeout: 120_000});

test("Claude GUI runs three native sandbox turns with five children and exports a verified environment", {timeout: 15 * 60_000}, async ({world, user, probe, evidence}) => {
  await user.see("New Claude session", {timeoutMs: 60_000});
  expect((await world.request("sessions", {captureConsent: true}, "invalid-client")).status).toBe(401);
  expect((await world.request("sessions", {captureConsent: true}, world.collaboratorToken)).status).toBe(403);
  if (world.packaged) expect(await world.runtimeWitness()).toEqual({protocol: "file:", bridge: true, embeddedServerSelected: true});
  await user.click("Retain private traces and full project snapshots");
  await user.click("New Claude session");
  const createPollStatuses: number[] = [];
  await probe.eventually(async () => {
    const response = await world.request("sessions"); createPollStatuses.push(response.status);
    return response;
  }, {within: 180_000, until: response => response.status === 200 && Array.isArray(response.body) && response.body.length === 1});
  expect(createPollStatuses.every(status => status === 200)).toBe(true);
  await user.see("Message Claude", {timeoutMs: 180_000, editable: true});
  await world.control({rejectInferenceOnce: true});
  const mintsBeforeTurns = (await world.witness()).mintRequests.length;
  for (let turn = 1; turn <= 3; turn++) {
    await user.type("Message Claude", `fixture-turn-${turn}: ${turn === 1 ? "Build the module and ask five subagents to check it." : "Continue developing and check the prior changes."}`);
    await user.click("Send");
    await probe.eventually(() => world.session(), {within: 180_000, until: session => session?.turns.length === turn && session.turns[turn - 1].status !== "running"});
    const session = await world.session();
    expect(session.turns[turn - 1].status, JSON.stringify(session)).toBe("complete");
    expect(session.capture).toBe("complete");
    expect(session.modelIsolation.status).toBe("observed");
    expect(session.modelIsolation.observedModels).toEqual(["claude-opus-5-5"]);
    const authorizationWitness = await world.witness();
    expect(authorizationWitness.tokenRejections).toBe(1);
    // One initial mint per turn, plus exactly one remint after the real 401.
    expect(authorizationWitness.mintRequests.length - mintsBeforeTurns).toBe(turn + 1);
    expect(session.authorization.budget.status).toBe(turn === 3 ? "unknown" : "known");
    const budgetText = turn === 3 ? "Model allowance has not been reported by the backend." : turn === 2 ? "model no limit · Session: no limit · Account day: 18,000 tokens" : "model 7,000 tokens · Session: 4,000 tokens · Account day: 18,000 tokens";
    await probe.eventually(() => probe.dom('[aria-label="Model allowance"]'), {within: 10_000, until: result => result.elements[0]?.text.includes(budgetText) === true});
    await probe.eventually(() => probe.dom('textarea[aria-label="Message Claude"]:not(:disabled)'), {within: 10_000, until: result => result.elements.length === 1});
    await user.see("Message Claude", {editable: true});
    if (turn === 1) {
      await user.reload(); await user.see("Claude session");
      await probe.eventually(() => probe.dom('[aria-label="Claude session"] option'), {within: 30_000, until: result => result.elements.length === 2});
      await user.click("Claude session"); await user.press("End"); await user.press("Enter");
      await user.see("Message Claude", {editable: true});
    }
    await world.control({budgetMode: turn === 1 ? "unlimited" : "unknown"});
  }
  await user.type("Verification command", "test -f /home/node/environment-marker && test -x /workspace/check.sh && test ! -e /workspace/seed.txt && test $(ls /workspace/child-*.txt | wc -l) -eq 5 && grep 'second turn' /workspace/answer.txt");
  await user.click("Verify restore");
  await user.see({testId: "claude-notice"}, {text: "Environment restored and verification passed with network access disabled.", timeoutMs: 180_000});
  world.prepareDownload();
  await user.click("Download private ZIP");
  await user.see({testId: "claude-notice"}, {text: "Private session ZIP downloaded.", timeoutMs: 180_000});
  await world.control({checkpointEnabled: false});
  await user.click("Upload private session");
  await user.see({testId: "claude-notice"}, {text: "Native traces uploaded. Environment upload is disabled by the backend; the complete ZIP remains on this device.", timeoutMs: 180_000});
  const nativeOnly = await world.witness();
  expect(nativeOnly.archives.map((archive: {request: {payload: string}}) => archive.request.payload)).toEqual(["claude_native"]);
  await world.control({checkpointEnabled: true});
  await user.click("Upload private session");
  await user.see({testId: "claude-notice"}, {text: "Private session uploaded. Backend receipts confirm the native traces and environment arrived.", timeoutMs: 180_000});
  const session = await world.session(), result = await world.nativeEvidence(session.id), witness = await world.witness();
  if (world.packaged) expect(await world.downloaded()).toBe(result.zipBytes);
  const display = (await world.request(`sessions/${session.id}/events`)).body;
  expect(display.filter((event: {type: string}) => event.type === "user")).toHaveLength(3);
  expect(display.filter((event: {type: string}) => event.type === "result")).toHaveLength(3);
  expect(display.some((event: {type: string; text: string; turn: number}) => event.type === "tool" && event.text === "Read" && event.turn === 3)).toBe(true);
  expect(display.map((event: {turn: number}) => event.turn)).toEqual(display.map((event: {turn: number}) => event.turn).sort((a: number, b: number) => a-b));
  const desktop = await world.desktopExport(session.id);
  expect(desktop?.status).toBe(200); expect(desktop?.bytes).toBe(result.zipBytes);
  if (world.packaged) expect(await world.cancelDesktopExport(session.id)).toEqual({active: true, outcome: "cancelled", stillActive: false});
  expect(result.manifest.transport).toBe("sdk");
  expect(result.manifest.status).toBe("complete");
  expect(result.manifest.files.filter((file: {path: string}) => /subagents\/agent-.*\.jsonl$/.test(file.path))).toHaveLength(5);
  expect(result.manifest.files.some((file: {thinkingBlocks: number}) => file.thinkingBlocks > 0)).toBe(true);
  expect(result.manifest.streams.sdk).toBeGreaterThan(0); expect(result.manifest.streams.hooks).toBeGreaterThan(0);
  expect(result.manifest.qc.humanPromptCandidates).toBe(3);
  expect(result.manifest.qc.childPromptRecords).toBeGreaterThanOrEqual(5);
  expect(result.manifest.qc.exposedThinkingBlocks).toBeGreaterThan(0);
  expect(result.readWitnesses).toHaveLength(1);
  expect(result.replay.status).toBe("restored"); expect(result.zipBytes).toBeGreaterThan(0);
  expect(new Set([result.state.base.file, ...result.state.turns.map((turn: {after: {file: string}}) => turn.after.file)]).size).toBe(1);
  expect(witness.uploadRetryInjected).toBe(true); expect(witness.uploadLossInjected).toBe(true);
  expect(witness.uploadsComplete).toBe(2); expect(witness.uploadedBytes).toBe(result.zipBytes);
  expect(witness.presignedAuthLeaks).toBe(0);
  expect(witness.archives.map((archive: {request: {payload: string}}) => archive.request.payload).sort()).toEqual(["claude_checkpoint", "claude_native"]);
  expect(witness.archives.every((archive: {request: {session_id: string; contract_hash: string}}) => archive.request.session_id === session.id && archive.request.contract_hash === result.state.contractSha256)).toBe(true);
  expect(witness.hostFiles).toEqual(world.initialHostFiles);
  const layout = await world.layout();
  expect(layout.lastMessageBottom).toBeLessThanOrEqual(layout.conversationBottom);
  expect(layout.composerTop).toBeGreaterThanOrEqual(layout.conversationBottom);
  expect(witness.requests.every((r: {userAgent: string; model: string}) => /claude-cli/.test(r.userAgent) && r.model === "claude-opus-5-5")).toBe(true);
  expect(witness.inferenceDenials).toEqual([]);
  expect(witness.requests.every((r: {app: string; beta: string; box: string; client: string; session: string}) => r.app === "cli" && r.beta.includes("claude-code-") && r.box === "1" && /^desktop\/[0-9]/.test(r.client) && r.session === session.id)).toBe(true);
  expect(result.state.modelIsolation.status).toBe("observed");
  expect(result.state.modelIsolation.observedModels).toEqual(["claude-opus-5-5"]);
  const authorizationRetries = result.modelRequests.filter((event: {authorizationFailures?: number[]}) => event.authorizationFailures?.length);
  expect(authorizationRetries).toHaveLength(1);
  expect(authorizationRetries[0]).toMatchObject({type: "response", status: 200, authorizationFailures: [401]});
  expect(result.state.contract.model).toBe("claude-opus-5-5");
  expect(result.state.contract.execution).toMatchObject({kind: "docker", os: "linux", workspace: "session-copy"});
  const callsBeforeMutation = witness.calls;
  const restoreModel = await world.mutateSession(session.id, "model");
  try { expect((await world.request(`sessions/${session.id}/turns`, {prompt: "Do not reuse a changed model"})).status).not.toBe(202); }
  finally { await restoreModel(); }
  const restoreContract = await world.mutateSession(session.id, "legacy");
  try {
    expect((await world.request(`sessions/${session.id}/turns`, {prompt: "Do not resume an unattested legacy session"})).status).not.toBe(202);
    expect((await world.exportReceipt(session.id)).status).toBe(200);
  } finally { await restoreContract(); }
  expect((await world.witness()).calls).toBe(callsBeforeMutation);
  const before = witness.calls; await world.access(false);
  const paused = await world.request(`sessions/${session.id}/turns`, {prompt: "This must not reach inference"});
  if (paused.status === 202) {
    const denied = await probe.eventually(() => world.session(), {within: 180_000, until: state => state.turns.length === 4 && state.turns[3].status !== "running"});
    expect(denied.turns[3].status).toBe("failed");
  }
  expect((await world.witness()).calls).toBe(before);
  expect((await world.request(`sessions/${session.id}`)).status).toBe(200);
  expect((await world.exportReceipt(session.id)).status).toBe(200);
  await world.access(true);
  await user.screenshot();
  if (world.packaged) {
    await world.switchToEmptyWorkspace();
    await user.see("New Claude session");
    await probe.eventually(() => probe.dom('[aria-label="Claude conversation"]'), {within: 30_000, until: state => state.elements.length === 0});
    expect((await probe.dom('textarea[aria-label="Message Claude"]')).elements).toHaveLength(0);
    expect((await probe.dom('[aria-label="Claude session"] option')).elements).toHaveLength(1);
  }
  evidence.recordAssertionEvidence("GUI uses native Claude Code and captures every child inside the sandbox", "Three real SDK turns resumed one UUID across a page reload; five child transcripts, thinking blocks, SDK events and hooks were retained. Host project was unchanged. Unselected accounts and collaborator tokens could not start work.", true);
  evidence.recordAssertionEvidence("One model remains fixed across children and resume", "A child explicitly requested Haiku, but all actual managed inference requests and provider identities stayed on Opus. A changed model and missing legacy contract both blocked continuation without upstream calls; the legacy evidence remained exportable.", true);
  evidence.recordAssertionEvidence("GUI resumes after one rejected inference grant without contaminating model evidence", "The first turn received a real HTTP 401. Exactly one additional grant mint recovered it; the saved policy response records [401] followed by 200. All three GUI turns, including resume after reload, completed with observed Opus-only identity and a restored replay.", true);
  evidence.recordAssertionEvidence("Private ZIP retains restorable full environments", "The exported checkpoint loaded into a separate network-disabled container. The verification command checked a file outside the project, executable mode, deletion, all five child outputs and the second-turn edit.", true);
  evidence.recordAssertionEvidence("Sealed native and environment uploads recover independently", "Canonical ORSEAL01 multipart upload recovered from a transient 503 and a lost acknowledged part. The fixture decrypted both payloads, verified plaintext hashes and every native manifest member, and received no device bearer on presigned PUTs. Native traces completed while checkpoint upload was disabled, then the checkpoint resumed after enablement.", true);
  evidence.recordAssertionEvidence("Desktop archive transfer streams the full local-server bundle", "The actual desktop transfer helper saved the same ZIP from the real product server to a test-selected save-dialog destination, beyond the ordinary inbox transfer size cap.", true);
  if (world.packaged) evidence.recordAssertionEvidence("Packaged Electron runs the Claude journey through its embedded server", "The installed-layout binary loaded file assets and its actual preload bridge without a development renderer or server override. Three turns, five children, restore, upload and the real native save dialog completed against the packaged embedded server.", true);
});

const connectionTest = spec.world(claudeConnectionWorld, {needs: {placement: "local", commands: ["bun", "pnpm"]}, timeout: 120_000});
connectionTest("Claude connection refresh keeps host authority, remote isolation and cancellation", {timeout: 120_000}, async ({world, user, probe, evidence}) => {
  await user.see("New Claude session", {timeoutMs: 60_000});
  await probe.eventually(() => probe.dom('[aria-label="Claude session"] option'), {within: 15_000, until: result => result.elements.length === 2});
  await user.click("Claude session"); await user.press("End"); await user.press("Enter");
  await user.see("Message Claude", {editable: true});
  const initial = await world.connectionWitness();
  expect(initial.requests.filter((request: {accepted: boolean}) => !request.accepted)).toEqual([]);
  // The HTTP fixture requires host authority even with a valid owner bearer.
  expect((await world.request("sessions")).status).toBe(403);
  await world.connectionControl({hostToken: "fixture-host-2"});
  expect((await world.request("sessions", undefined, undefined, "fixture-host-1")).status).toBe(403);
  const beforeRotation = (await world.connectionWitness()).requests.length;
  await world.publishHostToken("fixture-host-2");
  await probe.eventually(() => world.connectionWitness(), {within: 15_000, until: state => state.requests.slice(beforeRotation).some((request: {route: string; accepted: boolean}) => request.route.endsWith("/events") && request.accepted)});
  await user.type("Message Claude", "Resume after host-token rotation"); await user.click("Send");
  await probe.eventually(() => probe.dom('[aria-label="Capture status"]'), {within: 10_000, until: result => result.elements[0]?.text.includes("2 turns") === true});
  await user.click("Download private ZIP");
  await probe.eventually(() => world.connectionWitness(), {within: 10_000, until: state => state.startedExports === 1});
  await user.click("Cancel download");
  await user.see({testId: "claude-notice"}, {text: "Download cancelled."});
  await probe.eventually(() => world.connectionWitness(), {within: 10_000, until: state => state.cancelledExports === 1});
  const local = (await world.connectionWitness()).requests.slice(beforeRotation);
  expect(local.every((request: {accepted: boolean; hostMatches: boolean}) => request.accepted && request.hostMatches)).toBe(true);
  expect(local.some((request: {route: string}) => request.route.endsWith("/turns"))).toBe(true);
  expect(local.some((request: {route: string}) => request.route.endsWith("/export"))).toBe(true);

  await world.navigateConnectionWorkspace(true);
  await probe.eventually(() => probe.dom('[aria-label="Claude session"] option'), {within: 15_000, until: result => result.elements.length === 2});
  await user.click("Claude session"); await user.press("End"); await user.press("Enter");
  await user.see("Message Claude", {editable: true});
  await user.type("Message Claude", "Use the remote workspace credentials"); await user.click("Send");
  await probe.eventually(() => probe.dom('[aria-label="Capture status"]'), {within: 10_000, until: result => result.elements[0]?.text.includes("3 turns") === true});
  const remote = (await world.connectionWitness()).requests.filter((request: {remote: boolean}) => request.remote);
  expect(remote.length).toBeGreaterThan(0);
  expect(remote.every((request: {accepted: boolean; hostPresent: boolean}) => request.accepted && !request.hostPresent)).toBe(true);

  await world.connectionControl({holdCreate: true});
  await user.click("Retain private traces and full project snapshots"); await user.click("New Claude session");
  await probe.eventually(() => world.connectionWitness(), {within: 10_000, until: state => state.requests.some((request: {remote: boolean; method: string; route: string}) => request.remote && request.method === "POST" && request.route.endsWith("/sessions"))});
  await world.navigateConnectionWorkspace(false);
  await probe.eventually(() => world.connectionWitness(), {within: 10_000, until: state => state.cancelledCreates === 1});
  await world.connectionControl({available: false, crashedTurn: true, exportMode: "blocked"});
  await world.publishHostToken("fixture-host-2");
  await user.see({text: "Saved sessions"}, {timeoutMs: 10_000});
  await user.click("Claude session"); await user.press("End"); await user.press("Enter");
  await user.see("Download private ZIP");
  await user.click("Download private ZIP");
  await user.see({text: "Another process is using this session or its operation owner is unknown"}, {timeoutMs: 10_000});
  expect((await probe.dom('[data-testid="claude-notice"]')).elements).toHaveLength(0);
  await world.connectionControl({exportMode: "complete"});
  await user.click("Download private ZIP");
  await user.see({testId: "claude-notice"}, {text: "Private session ZIP downloaded."});
  const offline = await world.connectionWitness();
  expect(offline.available).toBe(false); expect(offline.lastTurnStatus).toBe("running");
  expect(offline.completedExports).toBe(1);
  expect(offline.requests.some((request: {route: string}) => request.route.endsWith("/recover"))).toBe(false);
  expect((await world.witness()).calls).toBe(0);
  evidence.recordAssertionEvidence("Claude requests retain current local host authority and isolate remote credentials", "A missing host token was refused. The mounted route refreshed on settings publication and resumed polling, a turn and export with the rotated token. Remote polling and turns used the remote bearer and received no local host header.", true);
  evidence.recordAssertionEvidence("Route cancellation reaches HTTP requests", "Cancelling a stalled archive closed its response stream without a download success notice. Navigating away from a pending session creation aborted its HTTP request. This focused fixture made zero inference calls and prepared no sandbox.", true);
  evidence.recordAssertionEvidence("Saved evidence remains downloadable after an unfinished turn while Claude is unavailable", "A saved running turn did not disable export when both account access and sandbox readiness were off. The server's active-owner refusal remained visible; after that lock cleared, export succeeded without recovery or any inference call. The historical turn still read running.", true);
});

test("Claude rejects invalid session grants and quota denial without retrying or hiding saved evidence", {timeout: 12 * 60_000}, async ({world, probe, evidence}) => {
  const faults = [
    {bindingFault: "session"}, {bindingFault: "model"}, {bindingFault: "upstream"}, {bindingFault: "contract"},
    {expiresIn: 901}, {expiresIn: 10, refreshAfter: 11}, {refreshAfter: 0}, {budgetMode: "wrong-model"}, {budgetMode: "wrong-session"}, {mintStatus: 429},
  ];
  const created = await world.request("sessions", {captureConsent: true});
  expect(created.status).toBe(201);
  const id = created.body.id;
  for (const [index, fault] of faults.entries()) {
    await world.control({bindingFault: null, expiresIn: 900, refreshAfter: 600, mintStatus: 200, budgetMode: "known", ...fault});
    const before = await world.witness();
    expect((await world.request(`sessions/${id}/turns`, {prompt: "fixture-turn-grant: This must not reach inference."})).status).toBe(202);
    const state = await probe.eventually(async () => (await world.request(`sessions/${id}`)).body, {within: 180_000, until: session => session.turns.length === index + 1 && session.turns[index].status !== "running"});
    expect(state.turns[index].status).toBe("failed");
    const after = await world.witness();
    expect(after.calls).toBe(before.calls);
    expect(after.mintRequests.length).toBe(before.mintRequests.length + 1);
    expect(after.mintRequests.at(-1)).toMatchObject({session_id: id, model: "claude-opus-5-5", contract_hash: state.contractSha256});
    expect(after.mintRequests.at(-1).project_key).toMatch(/^[a-f0-9]{12}$/);
    expect(after.mintRequests.at(-1).client).toBeTruthy();
  }
  expect((await world.exportReceipt(id)).status).toBe(200);
  evidence.recordAssertionEvidence("Short-lived grants bind inference to the immutable session contract", "Wrong session, requested or upstream model, contract bindings and invalid expiration/refresh values all refused inference. Each failed attempt made exactly one token request and preserved an exportable session.", true);
  evidence.recordAssertionEvidence("Model quota exhaustion does not create an automatic retry storm", "A 429 from the session token endpoint stopped before inference after one token request, while the saved environment remained readable and exportable.", true);
});

test("Claude accepts valid refresh boundaries and preserves model quota metadata", {timeout: 8 * 60_000}, async ({world, user, probe, evidence}) => {
  await user.see("New Claude session", {timeoutMs: 60_000});
  await world.control({refreshAfter: 1, expiresIn: 1, budgetMode: "null"});
  await user.click("Retain private traces and full project snapshots");
  await user.click("New Claude session");
  await user.see("Message Claude", {timeoutMs: 180_000, editable: true});
  for (let turn = 1; turn <= 2; turn++) {
    const before = await world.witness();
    await user.type("Message Claude", `fixture-turn-authorization-${turn}: Check the model allowance response from inside this sandbox.`);
    await user.click("Send");
    const session = await probe.eventually(() => world.session(), {within: 180_000, until: state => state?.turns.length === turn && state.turns[turn - 1].status !== "running"});
    expect(session.turns[turn - 1].status).toBe("complete");
    expect(session.capture).toBe("complete");
    expect(session.modelIsolation.status).toBe("observed");
    expect(session.authorization.budget.status).toBe(turn === 1 ? "unknown" : "known");
    const after = await world.witness();
    expect(after.calls - before.calls).toBe(2);
    if (turn === 1) expect(after.mintRequests.length - before.mintRequests.length).toBeGreaterThan(1);
    const label = turn === 1 ? "Model allowance has not been reported by the backend." : "model 7,000 tokens";
    await probe.eventually(() => probe.dom('[aria-label="Model allowance"]'), {within: 10_000, until: value => value.elements[0]?.text.includes(label) === true});
    await probe.eventually(() => probe.dom('textarea[aria-label="Message Claude"]:not(:disabled)'), {within: 10_000, until: value => value.elements.length === 1});
    await world.control({refreshAfter: 900, expiresIn: 900, budgetMode: "known"});
  }
  const session = await world.session();
  const proof = await world.request(`sessions/${session.id}/verify`, {command: `node -e 'const p=require("./authorization-checked.json"), h=p.headers; if(p.status!==429 || h["x-should-retry"]!=="false" || h["retry-after"]!=="60" || h["x-omnirush-grant-scope"]!=="model" || h["x-omnirush-grant-bucket"]!=="model:claude-opus-5-5" || h["x-omnirush-grant-resets-at"]!=="2037-09-24T00:00:00Z" || h["x-ratelimit-limit-tokens"]!=="8000" || h["x-ratelimit-remaining-tokens"]!=="0" || h["x-private-provider-secret"]!==undefined) process.exit(1)'`});
  expect(proof.status).toBe(200); expect(proof.body.status).toBe("restored");
  evidence.recordAssertionEvidence("Valid boundary grants run without inventing an allowance", "Two SDK turns completed with refresh_after one and equal to expires_in. The short-lived grant caused fresh mint requests; budget:null stayed visibly unknown and the next valid snapshot displayed the model allowance.", true);
  evidence.recordAssertionEvidence("Quota refusal metadata survives the managed broker without provider secrets", "A sandbox tool observed 429, no-retry, Retry-After, model scope, bucket, reset and token limits. An unrelated provider-secret header was absent. Network-disabled restore verified the recorded response.", true);
});

test("Claude refuses contaminated provider identities and marks missing identity as unknown", {timeout: 12 * 60_000}, async ({world, probe, evidence}) => {
  for (const responseModel of ["claude-haiku-4-5-20251001", null]) {
    await world.control({responseModel});
    const created = await world.request("sessions", {captureConsent: true});
    expect(created.status).toBe(201);
    const id = created.body.id;
    const beforeCalls = (await world.witness()).calls;
    expect((await world.request(`sessions/${id}/turns`, {prompt: "fixture-turn-identity: Inspect the project."})).status).toBe(202);
    const state = await probe.eventually(async () => (await world.request(`sessions/${id}`)).body, {within: 180_000, until: session => session.turns.length === 1 && session.turns[0].status !== "running"});
    expect(state.modelIsolation.status).toBe(responseModel ? "invalid" : "unknown");
    if (responseModel) expect(state.modelIsolation.observedModels).toContain(responseModel);
    else expect(state.modelIsolation.observedModels).toEqual([]);
    expect(state.turns[0].status).toBe("failed");
    const display = (await world.request(`sessions/${id}/events`)).body;
    expect(display.filter((event: {type: string}) => event.type === "tool")).toEqual([]);
    const before = (await world.witness()).calls;
    expect(before).toBe(beforeCalls + 1);
    expect((await world.request(`sessions/${id}/turns`, {prompt: "Do not continue unverified identity"})).status).not.toBe(202);
    expect((await world.witness()).calls).toBe(before);
    const archive = await world.exportReceipt(id);
    expect(archive.status).toBe(200); expect(archive.bytes).toBeGreaterThan(0);
  }
  await world.control({resetResponseModel: true});
  const guarded = await world.request("sessions", {captureConsent: true});
  expect(guarded.status).toBe(201);
  const beforeGuard = (await world.witness()).calls;
  expect((await world.request(`sessions/${guarded.body.id}/turns`, {prompt: "fixture-turn-broker-guard: Probe the managed session model boundary."})).status).toBe(202);
  const guardedState = await probe.eventually(async () => (await world.request(`sessions/${guarded.body.id}`)).body, {within: 180_000, until: session => session.turns.length === 1 && session.turns[0].status !== "running"});
  expect(guardedState.modelIsolation.status).toBe("invalid");
  expect(guardedState.modelIsolation.rejectedRequests).toBeGreaterThan(0);
  const afterGuard = await world.witness();
  expect(afterGuard.calls).toBe(beforeGuard + 1);
  expect(afterGuard.requests.every((request: {model: string}) => request.model === "claude-opus-5-5")).toBe(true);
  evidence.recordAssertionEvidence("Provider identity is checked before any tool can run", "A response naming another model made the session invalid; a response without identity made it unknown. Each stopped after exactly one upstream call and exposed no tool call to the SDK. Both refused another turn while preserving exportable evidence.", true);
  evidence.recordAssertionEvidence("The managed broker blocks a tool-requested model switch", "A sandbox tool attempted to request Haiku using its own scoped session bearer. The request was recorded as rejected and invalidated the session; only the original Opus request reached upstream.", true);
});
