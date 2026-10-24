// Bun-owned fixture: real product HTTP server + real SDK/container, only
// inference and account services are synthetic. No personal credentials.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { FakeArchiveServer } from "../../../../apps/server/src/session-archive/fake-archive-server.js";
import { readTar, testKeys } from "../../../../apps/server/src/session-archive/test-helpers.js";
import { openSealedBuffer } from "../../../../apps/server/src/session-archive/seal.js";
import type { ServerConfig } from "../../../../apps/server/src/types.js";
declare const Bun: {serve(options: {hostname: string; port: number; fetch(req: Request): Response | Promise<Response>}): {port: number; stop(force?: boolean): void}};
const root = process.env.CLAUDE_LAB_DIR;
if (!root) throw new Error("CLAUDE_LAB_DIR required");
fs.mkdirSync(root, {recursive: true});
const project = path.join(root, "project"); fs.mkdirSync(project, {recursive: true});
fs.writeFileSync(path.join(project, "seed.txt"), "seed stays on host\n");
process.env.OMNIRUSH_RUNTIME_DB = path.join(root, "runtime.sqlite");
process.env.OMNIRUSH_TOKEN_STORE = path.join(root, "tokens.json");
const deviceToken = process.env.CLAUDE_LAB_DEVICE_TOKEN ?? "device-fixture";
let access = true, owner = process.env.CLAUDE_LAB_OWNER ?? "fixture-owner", calls = 0;
let responseModel: string | null | undefined;
let mintStatus = 200;
let expiresIn = 900, refreshAfter = 600;
let budgetMode: "known" | "unlimited" | "unknown" | "null" | "wrong-model" | "wrong-session" = "known";
let bindingFault: "session" | "model" | "upstream" | "contract" | null = null;
const grants = new Map<string, {session: string; model: string; contract: string; client: string}>();
const bindingIds = new Map<string, string>();
const mintRequests: Array<Record<string, unknown>> = [];
let revokedGrants = 0;
let rejectInferenceOnce = false, tokenRejections = 0;
const inferenceDenials: Array<Record<string, unknown>> = [];
const requests: Array<Record<string, unknown>> = [];
let checkpointEnabled = false;
const archives = new Map(["claude_native", "claude_checkpoint"].map(payload => {
  const server = new FakeArchiveServer(); server.token = deviceToken; server.partSize = 8 * 1024 * 1024; server.policy = {project_folders: true};
  return [payload, server];
}));
const archiveOwners = new Map<string, FakeArchiveServer>();
const archiveWitnesses = new Map<string, Record<string, unknown>>();
let presignedAuthLeaks = 0;
const captureCapabilities = () => ({schema: 1, native: {enabled: access, max_bytes: 67_108_864}, checkpoint: {enabled: access && checkpointEnabled, max_bytes: 536_870_912, retention_days: null}});
let uploadRetryInjected = false, uploadLossInjected = false, uploadedBytes = 0, uploadsComplete = 0;
const uploadRoot = path.join(root, "received"); fs.mkdirSync(uploadRoot, {recursive: true});
const gateway = Bun.serve({hostname: "127.0.0.1", port: 0, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/control") {
    const body = await req.json();
    if (typeof body.access === "boolean") access = body.access;
    if (body.rejectInferenceOnce === true) rejectInferenceOnce = true;
    if (typeof body.checkpointEnabled === "boolean") checkpointEnabled = body.checkpointEnabled;
    if (typeof body.owner === "string") owner = body.owner;
    if (body.responseModel === null || typeof body.responseModel === "string") responseModel = body.responseModel;
    if (body.resetResponseModel === true) responseModel = undefined;
    if (typeof body.mintStatus === "number") mintStatus = body.mintStatus;
    if (typeof body.expiresIn === "number") expiresIn = body.expiresIn;
    if (typeof body.refreshAfter === "number") refreshAfter = body.refreshAfter;
    if (["known", "unlimited", "unknown", "null", "wrong-model", "wrong-session"].includes(body.budgetMode)) budgetMode = body.budgetMode;
    if (body.bindingFault === null || ["session", "model", "upstream", "contract"].includes(body.bindingFault)) bindingFault = body.bindingFault;
    return Response.json({ok: true});
  }
  if (url.pathname === "/witness") return Response.json({calls, requests, inferenceDenials, mintRequests, revokedGrants, tokenRejections, hostFiles: fs.readdirSync(project), uploadRetryInjected, uploadLossInjected, uploadedBytes, uploadsComplete, presignedAuthLeaks, archives: [...archiveWitnesses.values()]});
  if (url.pathname === "/device/me") return Response.json({id: owner, status: "active", approval_state: "approved"});
  if (url.pathname === "/collect/capabilities") return Response.json({claude_code: {enabled: access, version: "2.1.306",
    sdk: {package: "@anthropic-ai/claude-agent-sdk", version: "0.3.306", integrity: "sha512-kmxcd+4WNhqhqnzODRPM5aOKb1EH2EdlRsf7ZeMx8uQsC1tHAHgHftQGFXGT8yMaYaYlDP9BGYJy1/aYv7IhkQ=="},
    models: access ? ["claude-opus-5-5"] : [], capture: captureCapabilities()}});
  if (url.pathname === "/device/claude-token") {
    const body = await req.json(); mintRequests.push(body);
    if (req.headers.get("x-omnirush-client") !== body.client) return Response.json({detail: "client_version_required"}, {status: 403});
    if (!access) return Response.json({detail: "claude_not_available"}, {status: 403});
    if (mintStatus !== 200) return Response.json({detail: "model_allowance_exhausted"}, {status: mintStatus});
    const token = `orc_${createHash("sha256").update(`${owner}:${body.session_id}`).digest("base64url")}`;
    let bindingId = bindingIds.get(body.session_id);
    if (!bindingId) { bindingId = randomUUID(); bindingIds.set(body.session_id, bindingId); }
    grants.set(token, {session: body.session_id, model: body.model, contract: body.contract_hash, client: body.client});
    const asOf = new Date().toISOString(), resetsAt = new Date(Date.now() + 60 * 60_000).toISOString(), unlimited = budgetMode === "unlimited";
    const budget = budgetMode === "unknown" ? undefined : budgetMode === "null" ? null : {as_of: asOf,
      allowance: {scope: "day", limit: 20_000, remaining: 18_000, resets_at: resetsAt},
      model: {key: budgetMode === "wrong-model" ? "claude-haiku-4-5-20251001" : body.model, limit: unlimited ? null : 8_000, remaining: unlimited ? null : 7_000, resets_at: unlimited ? null : resetsAt},
      session: {root_session_id: budgetMode === "wrong-session" ? randomUUID() : body.session_id, limit: unlimited ? null : 5_000, used: 1_000, remaining: unlimited ? null : 4_000}};
    return Response.json({token, budget, expires_in: expiresIn, refresh_after: refreshAfter, base_url: `http://127.0.0.1:${gateway.port}/inference`, binding: {
      binding_id: bindingId, session_id: bindingFault === "session" ? randomUUID() : body.session_id,
      root_session_id: body.session_id, model: bindingFault === "model" ? "claude-haiku-4-5-20251001" : body.model,
      upstream_model: bindingFault === "upstream" ? "claude-haiku-4-5-20251001" : body.model, contract_hash: bindingFault === "contract" ? "0".repeat(64) : body.contract_hash,
      created_at: new Date().toISOString(),
    }});
  }
  if (url.pathname === "/device/claude-token/revoke") {
    const body = await req.json();
    for (const [token, grant] of grants) if (grant.session === body.session_id) { grants.delete(token); revokedGrants++; }
    return new Response(null, {status: 204});
  }
  if (url.pathname === "/v1/models") return Response.json({data: []});
  if (url.pathname === "/archives/key") return Response.json({kid: testKeys.kid, public_key: testKeys.publicB64, alg: "X25519-HKDF-SHA256-A256GCM", policy: {all_folders: false, touched_files: false, project_folders: true}, limits: {max_upload_bytes: null, max_session_bytes: null, claude: captureCapabilities()}});
  if (url.pathname.startsWith("/s3/")) {
    if (req.headers.has("authorization") || req.headers.has("x-api-key")) presignedAuthLeaks++;
    const archiveId = url.pathname.split("/").at(-1)!.replace(/\.orseal$/, "");
    const archive = archiveOwners.get(archiveId); if (!archive) return new Response(null, {status: 404});
    if (!uploadRetryInjected) { uploadRetryInjected = true; return new Response(null, {status: 503}); }
    return archive.respond(`https://bucket.s3.test/${url.pathname.slice(4)}${url.search}`, {method: req.method, body: await req.arrayBuffer()});
  }
  if (url.pathname === "/archives" || url.pathname.startsWith("/archives/")) {
    if (!access) return Response.json({detail: "account_paused"}, {status: 403});
    const body = await req.json(), id = url.pathname === "/archives" ? body.archive_id : url.pathname.split("/")[2];
    let server = archiveOwners.get(id);
    if (url.pathname === "/archives") {
      if (!archives.has(body.payload) || body.harness !== "claude-code" || body.marker !== "project" || !body.binding_id || !/^[a-f0-9]{64}$/.test(body.contract_hash)) return Response.json({detail: "invalid_native_binding"}, {status: 422});
      if (body.payload === "claude_checkpoint" && !checkpointEnabled) return Response.json({detail: "archive_payload_disabled"}, {status: 409});
      server = archives.get(body.payload)!; archiveOwners.set(id, server);
    }
    if (!server) return Response.json({detail: "archive_not_found"}, {status: 404});
    if (url.pathname.endsWith("/complete") && !uploadLossInjected) {
      uploadLossInjected = true;
      server.archives.get(id)?.parts?.delete(1);
    }
    const response = await server.respond(`https://api.omnirush.test/omnirush${url.pathname}`, {method: req.method, headers: req.headers, body: JSON.stringify(body)});
    const result = await response.json();
    if (Array.isArray(result.parts)) result.parts = result.parts.map((part: {url: string}) => ({...part, url: part.url.replace("https://bucket.s3.test/", `http://127.0.0.1:${gateway.port}/s3/`)}));
    if (response.ok && url.pathname.endsWith("/complete") && !archiveWitnesses.has(id)) {
      const archive = server.archives.get(id)!;
      if (!archive.object || archive.status !== "uploaded") throw new Error("Archive completion omitted its object");
      const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
      if (hash(archive.object) !== archive.request.sha256) throw new Error("Sealed upload hash mismatch");
      const checkpoint = archive.request.payload === "claude_checkpoint";
      const plain = await openSealedBuffer(archive.object, testKeys.keyring, {expectedContent: checkpoint ? "zip" : "tar+zstd"});
      if (plain.length !== archive.request.plain_size || hash(plain) !== archive.request.plain_sha256) throw new Error("Unsealed upload hash mismatch");
      let manifest: Record<string, unknown> | undefined;
      if (checkpoint) {
        const file = path.join(uploadRoot, `${id}.zip`);
        fs.writeFileSync(file, plain, {mode: 0o600}); uploadedBytes = plain.length;
        manifest = JSON.parse(execFileSync(process.platform === "win32" ? "python" : "python3", ["-c", `import hashlib,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
 raw=archive.read('__omnirush__/manifest.json')
 assert hashlib.sha256(raw).hexdigest()==sys.argv[2]
 manifest=json.loads(raw)
 assert set(archive.namelist())=={'__omnirush__/manifest.json'}|{entry['path'] for entry in manifest['files']}
 for entry in manifest['files']:
  digest=hashlib.sha256(); size=0
  with archive.open(entry['path']) as source:
   while chunk:=source.read(1048576): digest.update(chunk); size+=len(chunk)
  assert size==entry['size'] and digest.hexdigest()==entry['sha256']
 print(json.dumps(manifest))`, file, String(archive.request.manifest_sha256)], {encoding: "utf8", maxBuffer: 8 * 1024 * 1024}));
      } else {
        const members = readTar(zstdDecompressSync(plain)), first = members[0];
        if (first?.name !== "__omnirush__/manifest.json" || hash(first.content) !== archive.request.manifest_sha256) throw new Error("Authoritative native manifest mismatch");
        manifest = JSON.parse(first.content.toString("utf8"));
        const expected = (manifest!.files as Array<{path: string; size: number; sha256: string}>);
        for (const member of members.slice(1)) {
          const item = expected.find(entry => entry.path === member.name);
          if (!item || item.size !== member.size || item.sha256 !== hash(member.content)) throw new Error("Native member mismatch");
        }
        if (expected.length !== members.length - 1) throw new Error("Native manifest includes missing members");
      }
      archiveWitnesses.set(id, {request: archive.request, manifest, sealedSha256: hash(archive.object), plainSha256: hash(plain), plainBytes: plain.length});
      uploadsComplete++;
      archive.parts?.clear(); archive.object = null;
    }
    return Response.json(result, {status: response.status});
  }
  if (!url.pathname.startsWith("/inference/v1/messages")) return Response.json({}, {status: 404});
  const bearer = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer /i, "");
  const grant = bearer ? grants.get(bearer) : undefined;
  if (!access || !grant) return Response.json({error: {type: "authentication_error", message: "Grant refused"}}, {status: 403});
  const body = await req.json();
  if (url.pathname.endsWith("count_tokens")) {
    if (body.metadata?.fixture_quota_probe === true) return Response.json({error: {type: "rate_limit_error", message: "The model allowance is exhausted"}}, {status: 429, headers: {
      "x-should-retry": "false", "retry-after": "60", "x-omnirush-grant-scope": "model", "x-omnirush-grant-bucket": "model:claude-opus-5-5",
      "x-omnirush-grant-resets-at": "2037-09-24T00:00:00Z", "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "0", "x-private-provider-secret": "fixture-must-not-forward",
    }});
    return Response.json({input_tokens: 100});
  }
  if (body.model !== grant.model) return Response.json({error: {type: "permission_error", message: "Model binding mismatch"}}, {status: 403});
  const wire = {userAgent: req.headers.get("user-agent"), model: body.model, thinking: body.thinking, session: req.headers.get("x-omnirush-session-id"), client: req.headers.get("x-omnirush-client"), app: req.headers.get("x-app"), beta: req.headers.get("anthropic-beta"), box: req.headers.get("x-omnirush-box")};
  if (wire.app !== "cli" || !wire.userAgent?.startsWith("claude-cli/") || !wire.beta?.includes("claude-code-") || wire.box !== "1" || wire.session !== grant.session || wire.client !== grant.client || !/^(desktop|cli)\/[0-9][A-Za-z0-9.+_-]{0,63}$/.test(wire.client ?? "")) {
    inferenceDenials.push(wire); return Response.json({error: {type: "permission_error", message: "Harness admission mismatch"}}, {status: 403});
  }
  if (rejectInferenceOnce) {
    rejectInferenceOnce = false; tokenRejections++;
    return Response.json({type: "error", error: {type: "authentication_error", message: "Fixture token expired before inference"}}, {status: 401});
  }
  calls++;
  requests.push(wire);
  const userText = (message: {role: string; content: unknown}) => message.role !== "user" ? "" : typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter(b => b.type === "text").map(b => b.text).join("\n") : "";
  const messages = body.messages;
  let start = messages.findLastIndex((m: {role: string; content: unknown}) => userText(m).includes("fixture-turn") || userText(m).includes("fixture-child"));
  if (start < 0) start = 0;
  const prompt = userText(messages[start]);
  const answered = messages.slice(start + 1).some((m: {content: unknown}) => Array.isArray(m.content) && m.content.some(b => b.type === "tool_result"));
  const child = /fixture-child-(\d)/.exec(prompt)?.[1];
  const tool = (name: string, input: Record<string, unknown>) => ({type: "tool_use", id: `toolu_${randomUUID().replaceAll("-", "")}`, name, input});
  let content: Array<Record<string, unknown>>;
  if (answered) content = [{type: "text", text: child ? `Child ${child} finished.` : "Development turn complete. Sandbox files updated."}];
  else if (child) content = [tool("Write", {file_path: `/workspace/child-${child}.txt`, content: `child-${child}\n`})];
  else if (prompt.includes("fixture-turn-1")) content = [
    {type: "thinking", thinking: "I will implement and check the project in the sandbox.", signature: "opaque-fixture-signature"},
    tool("Write", {file_path: "/workspace/answer.txt", content: "first turn\n"}),
    tool("Bash", {command: "printf 'environment survives\\n' > /home/node/environment-marker; printf '#!/bin/sh\\nexit 0\\n' > /workspace/check.sh; chmod +x /workspace/check.sh"}),
    ...Array.from({length: 5}, (_, i) => tool("Agent", {subagent_type: "general-purpose", ...(i === 0 ? {model: "haiku"} : {}), description: `Check module ${i + 1}`, prompt: `fixture-child-${i + 1}: Create your assigned child file.`})),
  ];
  else if (prompt.includes("fixture-turn-2")) content = [tool("Bash", {command: "test -f /home/node/environment-marker && test -x check.sh && printf 'second turn\\n' >> answer.txt; rm seed.txt"})];
  else if (prompt.includes("fixture-turn-stop")) content = [tool("Bash", {command: "printf 'partial\\n' > partial.txt; sleep 90"})];
  else if (prompt.includes("fixture-turn-broker-guard")) content = [tool("Bash", {command: `node --input-type=module -e 'const r=await fetch(process.env.ANTHROPIC_BASE_URL+"/v1/messages",{method:"POST",headers:{"authorization":"Bearer "+process.env.ANTHROPIC_AUTH_TOKEN,"content-type":"application/json"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:20,messages:[{role:"user",content:"Model isolation probe"}]})});console.log("model guard status",r.status);'`})];
  else if (prompt.includes("fixture-turn-authorization")) content = [tool("Bash", {command: `node --input-type=module <<'QUOTA_PROBE'
import fs from 'node:fs';
const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages/count_tokens', {
  method: 'POST', headers: {'authorization': 'Bearer ' + process.env.ANTHROPIC_AUTH_TOKEN, 'content-type': 'application/json'},
  body: JSON.stringify({model: 'claude-opus-5-5', metadata: {fixture_quota_probe: true}, messages: [{role: 'user', content: 'Quota metadata probe'}]}),
});
const proof = {status: response.status, headers: Object.fromEntries(response.headers)};
await response.body?.cancel();
fs.writeFileSync('/workspace/authorization-checked.json', JSON.stringify(proof));
console.log('Quota probe recorded');
QUOTA_PROBE`})];
  else content = [tool("Read", {file_path: "/workspace/answer.txt"})];
  const stop_reason = content.some(b => b.type === "tool_use") ? "tool_use" : "end_turn";
  const message = {id: `msg_${calls}`, type: "message", role: "assistant", ...(responseModel === null ? {} : {model: responseModel ?? body.model}), content, stop_reason, stop_sequence: null, usage: {input_tokens: 100, output_tokens: 30}};
  if (!body.stream) return Response.json(message);
  let output = "";
  const send = (type: string, data: Record<string, unknown>) => { output += `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`; };
  send("message_start", {message: {...message, content: [], stop_reason: null, usage: {input_tokens: 100, output_tokens: 0}}});
  for (const [index, block] of content.entries()) {
    send("content_block_start", {index, content_block: block.type === "tool_use" ? {...block, input: {}} : block.type === "thinking" ? {type: "thinking", thinking: "", signature: ""} : {type: "text", text: ""}});
    send("content_block_delta", {index, delta: block.type === "tool_use" ? {type: "input_json_delta", partial_json: JSON.stringify(block.input)} : block.type === "thinking" ? {type: "thinking_delta", thinking: block.thinking} : {type: "text_delta", text: block.text}});
    if (block.type === "thinking") send("content_block_delta", {index, delta: {type: "signature_delta", signature: block.signature}});
    send("content_block_stop", {index});
  }
  send("message_delta", {delta: {stop_reason, stop_sequence: null}, usage: {output_tokens: 30}}); send("message_stop", {});
  return new Response(output, {headers: {"content-type": "text/event-stream"}});
}});
if (process.env.CLAUDE_LAB_INFERENCE_ONLY === "1") {
  fs.writeFileSync(path.join(root, "ready.json"), JSON.stringify({gateway: `http://127.0.0.1:${gateway.port}`, root, project}), {mode: 0o600});
  const stop = () => { gateway.stop(true); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
} else {
const { startServer } = await import("../../../../apps/server/src/server.js");
const config: ServerConfig = {appVersion: "0.0.0-test", host: "127.0.0.1", port: 0, token: "owt_claude_fixture", hostToken: "owt_claude_host", approval: {mode: "auto", timeoutMs: 1000}, corsOrigins: ["*"], workspaces: [{id: "ws_claude", name: "Claude fixture", path: project, preset: "starter", workspaceType: "local"}], authorizedRoots: [project], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false, omnirushGatewayCredentials: {gatewayUrl: `http://127.0.0.1:${gateway.port}/v1`, accessToken: deviceToken, refreshToken: "refresh-fixture"}};
const server = await startServer(config);
const ownerToken = await (await fetch(`http://127.0.0.1:${server.port}/tokens`, {method: "POST", headers: {"x-omnirush-host-token": config.hostToken, "content-type": "application/json"}, body: JSON.stringify({scope: "owner", label: "Claude fixture"})})).json();
// A small HTTP boundary fixture for renderer connection/cancellation checks.
// It never prepares a sandbox or calls inference; full native proof stays above.
let connectionServer: ReturnType<typeof Bun.serve> | undefined;
if (process.env.CLAUDE_LAB_CONNECTION_ONLY === "1") {
  let hostToken = "fixture-host-1", holdCreate = false, available = true;
  let exportMode: "stream" | "blocked" | "complete" = "stream";
  const boundaryRequests: Array<{route: string; method: string; accepted: boolean; remote: boolean; hostMatches: boolean; hostPresent: boolean}> = [];
  let cancelledCreates = 0, cancelledExports = 0, startedExports = 0, completedExports = 0;
  const session = {id: "00000000-0000-4000-8000-000000000001", createdAt: new Date().toISOString(), model: "claude-opus-5-5", capture: "complete", replay: "restored", issues: [],
    turns: [{number: 1, status: "complete"}], compatibility: "current", modelIsolation: {status: "observed"}, contract: {execution: {os: "linux", architecture: "x64"}}};
  connectionServer = Bun.serve({hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    const cors = {"access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, x-omnirush-host-token", "access-control-allow-methods": "GET, POST, OPTIONS"};
    const json = (body: unknown, status = 200) => Response.json(body, {status, headers: cors});
    if (req.method === "OPTIONS") return new Response(null, {headers: cors});
    if (url.pathname === "/fixture/witness") return json({requests: boundaryRequests, cancelledCreates, cancelledExports, startedExports, completedExports, turns: session.turns.length, lastTurnStatus: session.turns.at(-1)?.status, available});
    if (url.pathname === "/fixture/control") {
      const body = await req.json();
      if (typeof body.hostToken === "string") hostToken = body.hostToken;
      if (typeof body.holdCreate === "boolean") holdCreate = body.holdCreate;
      if (typeof body.available === "boolean") available = body.available;
      if (body.crashedTurn === true) session.turns[session.turns.length - 1].status = "running";
      if (body.exportMode === "stream" || body.exportMode === "blocked" || body.exportMode === "complete") exportMode = body.exportMode;
      return json({ok: true});
    }
    const remote = url.pathname.startsWith("/remote/");
    const hostMatches = req.headers.get("x-omnirush-host-token") === hostToken;
    const hostPresent = req.headers.has("x-omnirush-host-token");
    const accepted = remote ? req.headers.get("authorization") === "Bearer fixture-remote" && !hostPresent : hostMatches;
    const pathname = remote ? url.pathname.slice("/remote".length) : url.pathname;
    if (pathname === "/workspaces" || pathname.includes("/claude/")) {
      boundaryRequests.push({route: pathname, method: req.method, accepted, remote, hostMatches, hostPresent});
      if (!accepted) return json({message: "Fixture requires the current connection credentials"}, 403);
      if (pathname === "/workspaces") return json({items: [config.workspaces[0], {id: "rem_ws_remote", name: "Remote Claude fixture", workspaceType: "remote", baseUrl: `${url.origin}/remote`, omnirushToken: "fixture-remote", omnirushWorkspaceId: "ws_remote"}]});
      const route = pathname.split("/claude/")[1];
      if (route === "status") return json({allowed: available, sandboxReady: available});
      if (route === "sessions" && req.method === "GET") return json([session]);
      if (route === "sessions" && holdCreate) return new Promise<Response>(resolve => {
        req.signal.addEventListener("abort", () => { cancelledCreates++; resolve(json({cancelled: true}, 499)); }, {once: true});
      });
      if (route === "sessions") return json(session, 201);
      if (route.endsWith("/turns")) { session.turns.push({number: session.turns.length + 1, status: "complete"}); return json({started: true}, 202); }
      if (route.endsWith("/events")) return json([{type: "assistant", text: "Connection fixture ready", turn: 1}]);
      if (route.endsWith("/export")) {
        startedExports++;
        if (exportMode === "blocked") return json({message: "Another process is using this session or its operation owner is unknown"}, 409);
        if (exportMode === "complete") { completedExports++; return new Response(new Uint8Array([80, 75, 3, 4]), {headers: {...cors, "content-type": "application/zip"}}); }
        return new Response(new ReadableStream({
          start(stream) { stream.enqueue(new Uint8Array([80, 75, 3, 4])); },
          cancel() { cancelledExports++; },
        }), {headers: {...cors, "content-type": "application/zip"}});
      }
      return json(session);
    }
    return fetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, {method: req.method, headers: req.headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(), signal: req.signal});
  }});
}
fs.writeFileSync(path.join(root, "ready.json"), JSON.stringify({baseUrl: `http://127.0.0.1:${connectionServer?.port ?? server.port}`, token: ownerToken.token, hostToken: connectionServer ? "fixture-host-1" : config.hostToken, gateway: `http://127.0.0.1:${gateway.port}`, workspaceId: "ws_claude", root}), {mode: 0o600});
const stop = async () => { connectionServer?.stop(true); await server.stop(); gateway.stop(true); process.exit(0); };
process.on("SIGTERM", () => void stop()); process.on("SIGINT", () => void stop());
}
