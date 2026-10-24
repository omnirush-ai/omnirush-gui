import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { NativeCapture } from "./native-capture.js";
import { ClaudeAccessError, ClaudeDeviceAccess } from "./access.js";
import { CLAUDE_VERSION, MODEL } from "./sandbox-assets.js";
import { SDK_INSTALL_PIN } from "./sandbox-lock.js";
import { ClaudeRuntime } from "./runtime.js";

test("managed Claude availability requires an enabled compatible catalog, never just relay access", async () => {
  const valid = {enabled: true, version: CLAUDE_VERSION, sdk: SDK_INSTALL_PIN, models: [MODEL]};
  for (const [code, allowed] of [
    [valid, true], [{...valid, enabled: false}, false], [{...valid, models: []}, false],
    [{...valid, models: ["claude-haiku-4-5-20251001"]}, false], [{...valid, sdk: {...SDK_INSTALL_PIN, version: "0.0.0"}}, false],
    [{...valid, sdk: null}, false], [{...valid, sdk: {...SDK_INSTALL_PIN, integrity: "sha512-wrong"}}, false],
    [{...valid, sdk: {...SDK_INSTALL_PIN, package: "@anthropic-ai/claude-code"}}, false],
    [{...valid, models: [MODEL, null]}, false], [{enabled: true}, false], [null, false],
  ] as const) {
    const routes: string[] = [];
    const access = new ClaudeDeviceAccess(async route => {
      routes.push(route);
      return Response.json(route === "device/me" ? {id: "owner"} : {claude_code: code});
    }, "cli/2.7.0");
    expect((await access.access()).capabilities?.includes("claude-code")).toBe(allowed);
    expect(routes).toEqual(["device/me", "collect/capabilities"]);
  }
});

test("managed grants reject provider keys and zero refresh, refresh from request time, and revoke the root", async () => {
  const context = {owner: "owner", sessionId: "00000000-0000-4000-8000-000000000001", workspaceId: "project", model: MODEL, contractSha256: "a".repeat(64)};
  const response = {token: "orc_" + "a".repeat(43), expires_in: 900, refresh_after: 600,
    base_url: "https://omnirush.ai/claude", budget: null,
    binding: {binding_id: "00000000-0000-4000-8000-000000000002", session_id: context.sessionId,
      root_session_id: context.sessionId, model: MODEL, upstream_model: MODEL, contract_hash: context.contractSha256}};
  for (const fault of [{token: "provider-key-fixture"}, {refresh_after: 0}, {refresh_after: 901}]) {
    const access = new ClaudeDeviceAccess(async () => Response.json({...response, ...fault}), "desktop/3.7.5");
    await expect(access.authorize(context)).rejects.toThrow("Invalid short-lived Claude authorization");
  }
  let now = 100_000, mints = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const requests: Array<{route: string; body: unknown; owner?: string}> = [];
  const access = new ClaudeDeviceAccess(async (route, init, owner) => {
    requests.push({route, body: JSON.parse(init!.body), owner});
    if (route.endsWith("/revoke")) return new Response(null, {status: 204});
    mints++; now += 2_000; // Mint latency consumes token lifetime.
    return Response.json(response);
  }, "desktop/3.7.5");
  try {
    const first = await access.authorize(context);
    expect(first.baseUrl).toBe("https://omnirush.ai/claude");
    expect(first.budget?.status).toBe("unknown");
    now = 699_999; await access.authorize(context); expect(mints).toBe(1);
    now = 700_000; await access.authorize(context); expect(mints).toBe(2);
    await access.authorize({...context, refresh: true}); expect(mints).toBe(3);
    expect(requests[0]).toMatchObject({route: "device/claude-token", owner: "owner", body: {
      session_id: context.sessionId, model: MODEL, contract_hash: context.contractSha256, client: "desktop/3.7.5",
    }});
    await access.revoke(context);
    expect(requests.at(-1)).toEqual({route: "device/claude-token/revoke", owner: "owner", body: {session_id: context.sessionId}});
    await access.authorize(context); expect(mints).toBe(4);
  } finally { clock.mockRestore(); }
});

test("managed access distinguishes retryable capacity from terminal allowance without exposing response bodies", async () => {
  const context = {owner: "owner", sessionId: "00000000-0000-4000-8000-000000000001", workspaceId: "project", model: MODEL, contractSha256: "a".repeat(64)};
  for (const retry of ["true", "false"]) {
    let requests = 0;
    const access = new ClaudeDeviceAccess(async () => {
      requests++;
      return Response.json({credential: "private-fixture-canary"}, {status: 429, headers: {"x-should-retry": retry, "retry-after": "30"}});
    }, "cli/2.7.0");
    try { await access.authorize(context); throw new Error("Expected rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(ClaudeAccessError);
      if (!(error instanceof ClaudeAccessError)) throw error;
      expect(error.message).toContain(retry === "false" ? "allowance" : "busy");
      expect(error.message).not.toContain("private-fixture-canary");
      expect(error.responseHeaders["x-should-retry"]).toBe(retry);
      expect(error.retryAfter).toBe("30");
    }
    expect(requests).toBe(1);
  }
});

test("session broker re-mints once on rejected authentication and never replays quota or server failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-broker-contract-")); roots.push(root);
  const id = "00000000-0000-4000-8000-000000000001", contractSha256 = "a".repeat(64);
  let status = 401, attempts = 0, successful = 0, authorizations = 0, refreshes = 0, first401 = true;
  let transportCalls = 0;
  const relay = Bun.serve({hostname: "127.0.0.1", port: 0, async fetch(req) {
    attempts++;
    expect(req.headers.get("x-api-key")).toMatch(/^orc_/);
    expect(req.headers.get("x-omnirush-session-id")).toBe(id);
    expect(req.headers.get("x-omnirush-box")).toBe("1");
    expect(req.headers.get("x-omnirush-client")).toBe("desktop/3.7.5");
    if (status === 200 || status === 401 && !first401) {
      successful++;
      return Response.json({type: "message", model: MODEL, content: [], stop_reason: "end_turn"});
    }
    first401 = false;
    return Response.json({type: "error", error: {type: "api_error", message: "fixture"}}, {status,
      headers: {"x-should-retry": status === 429 ? "false" : "true", "retry-after": "30"}});
  }});
  const runtime = new ClaudeRuntime({fetch: (input, init) => {
    transportCalls++;
    expect(input).toBe(`http://127.0.0.1:${relay.port}/v1/messages`);
    expect(init?.redirect).toBe("error");
    expect(init?.signal?.aborted).toBe(false);
    return globalThis.fetch(input, init);
  }, directory: root, surface: "gui", access: async () => ({owner: "owner", capabilities: ["claude-code"]}),
    authorize: async context => {
      authorizations++; if (context.refresh) refreshes++;
      return {owner: "owner", sessionId: id, model: MODEL, upstreamModel: MODEL, client: "desktop/3.7.5",
        baseUrl: `http://127.0.0.1:${relay.port}`, token: "orc_" + "a".repeat(43), contractSha256};
    }});
  // Isolate the actual HTTP broker from Docker setup; private access is confined to this boundary test.
  const session = {owner: "owner", id, model: MODEL, workspaceId: "project", contract: {}, contractSha256, turns: []};
  const broker = await Reflect.get(runtime, "broker").call(runtime, session, () => {});
  const endpoint = broker.baseUrl.replace("host.docker.internal", "127.0.0.1") + "/v1/messages";
  const request = () => fetch(endpoint, {method: "POST", headers: {authorization: `Bearer ${broker.token}`, "content-type": "application/json"},
    body: JSON.stringify({model: MODEL, messages: [], max_tokens: 1}), signal: AbortSignal.timeout(5_000)});
  try {
    const accepted = await request(); expect(accepted.status).toBe(200); await accepted.arrayBuffer();
    expect({attempts, successful, authorizations, refreshes}).toEqual({attempts: 2, successful: 1, authorizations: 2, refreshes: 1});
    expect(transportCalls).toBe(2);
    const journal = fs.readFileSync(path.join(Reflect.get(runtime, "dir").call(runtime, "owner", id), "policy", "model-requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(journal.map(event => event.type)).toEqual(["request", "provider_identity", "response"]);
    expect(journal.at(-1)).toMatchObject({status: 200, authorizationFailures: [401], completed: true});
    for (status of [429, 503]) {
      const before = attempts, renewed = refreshes;
      const denied = await request(); expect(denied.status).toBe(status);
      expect(denied.headers.get("x-should-retry")).toBe(status === 429 ? "false" : "true");
      expect(denied.headers.get("retry-after")).toBe("30"); await denied.arrayBuffer();
      expect(attempts).toBe(before + 1); expect(refreshes).toBe(renewed); expect(successful).toBe(1);
      expect(transportCalls).toBe(attempts);
    }
  } finally { await broker.close(); relay.stop(true); }
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-"))); roots.push(root);
  const options = { directory: path.join(root, "capture"), configDir: path.join(root, "config"), sessionId: "00000000-0000-4000-8000-000000000001", producerVersion: "fixture", surface: "gui" as const, transport: "sdk" as const, owner: "actor-a" };
  const project = path.join(options.configDir, "projects", "-workspace");
  fs.mkdirSync(project, { recursive: true });
  const source = path.join(project, `${options.sessionId}.jsonl`);
  const capture = new NativeCapture(options);
  return { root, options, project, source, capture };
}
const line = (value: unknown) => JSON.stringify(value) + "\n";
const user = (uuid: string) => ({ type: "user", uuid, parentUuid: null, message: { content: "hello" } });
const finish = { type: "finish" as const, processStopped: true, successfulResult: true };

test("copies every branch, unknown field, thinking signature and five child files byte for byte; excludes auth and other sessions", () => {
  const f = fixture();
  const original = line(user("prompt")) + line({ type: "assistant", uuid: "a", parentUuid: "prompt", future: { keep: true }, message: { content: [{ type: "thinking", thinking: "Visible summary", signature: "opaque-fixture" }, { type: "tool_use", id: "one", name: "Read" }, { type: "tool_use", id: "two", name: "Read" }] } })
    + line({ type: "user", uuid: "side", parentUuid: "a", message: { content: [{ type: "tool_result", tool_use_id: "one", content: "branch one" }] } })
    + line({ type: "user", uuid: "selected", parentUuid: "a", message: { content: [{ type: "tool_result", tool_use_id: "two", content: "branch two" }] } })
    + line({ type: "api-request-blob", message: { content: [{ type: "tool_use", id: "cached-context-only", name: "Bash" }, {type: "thinking", thinking: "Repeated context"}] } });
  fs.writeFileSync(f.source, original);
  fs.writeFileSync(path.join(f.project, "another-session.jsonl"), "DO_NOT_EXPORT_OTHER_SESSION");
  fs.writeFileSync(path.join(f.options.configDir, "credentials.json"), "DO_NOT_EXPORT_AUTH");
  const agents = ["child1", "child2", "child3", "child4", "child5"];
  const children = path.join(f.project, f.options.sessionId, "subagents"); fs.mkdirSync(children, { recursive: true });
  for (const agent of agents) {
    fs.writeFileSync(path.join(children, `agent-${agent}.jsonl`), line(user(agent)));
    fs.writeFileSync(path.join(children, `agent-${agent}.meta.json`), '{ "agentType": "test", "unknown": 5 }');
  }
  const manifest = f.capture.finish({ ...finish, expectedAgents: agents });
  expect(manifest.status).toBe("complete"); expect(manifest.replay).toBe("unverified");
  expect(manifest.files).toHaveLength(11);
  expect(manifest.qc).toMatchObject({ schema: 1, humanPromptCandidates: 1, childPromptRecords: 5, exposedThinkingBlocks: 1, opaqueThinkingBlocks: 0, reviewRequired: false });
  expect(manifest.files.find((file) => file.path.endsWith(`${f.options.sessionId}.jsonl`))).toMatchObject({ toolCalls: 2, toolResults: 2, thinkingBlocks: 1, pendingTools: [] });
  const out = path.join(f.root, "export"); f.capture.exportTo(out);
  expect(fs.readFileSync(path.join(out, "claude/projects/-workspace", `${f.options.sessionId}.jsonl`), "utf8")).toBe(original);
  expect(fs.readdirSync(path.join(out, "claude/projects/-workspace"))).toEqual([f.options.sessionId, `${f.options.sessionId}.jsonl`]);
  expect(fs.existsSync(path.join(out, "credentials.json"))).toBe(false);
});

test("partial native lines survive restart and prevent completeness until their real bytes arrive", () => {
  const f = fixture(); fs.writeFileSync(f.source, line(user("a")) + '{"type":"user","message":');
  const first = f.capture.finish(finish);
  expect(first.status).toBe("incomplete"); expect(first.files[0].tailBytes).toBeGreaterThan(0);
  const recovered = new NativeCapture(f.options);
  fs.appendFileSync(f.source, '{"content":"continued"}}\n');
  expect(recovered.finish(finish).status).toBe("complete");
  expect(recovered.verify().files[0].completeLines).toBe(2);
});

test("durable stream retries are idempotent, reject conflicting bytes and gaps, and recover an unacknowledged partial write", () => {
  const f = fixture(), bytes = Buffer.from(line(user("stream")));
  f.capture.recordStream("sdk", bytes, 0);
  const recovered = new NativeCapture(f.options);
  expect(recovered.recordStream("sdk", bytes, 0).streams.sdk).toBe(bytes.length);
  expect(() => recovered.recordStream("sdk", Buffer.from("bad"), 0)).toThrow("Conflicting");
  expect(() => recovered.recordStream("sdk", bytes, bytes.length + 1)).toThrow("offset gap");
  const next = Buffer.from(line(user("next")));
  fs.appendFileSync(path.join(f.options.directory, "events/sdk.jsonl"), next.subarray(0, 5));
  recovered.recordStream("sdk", next, bytes.length);
  expect(fs.readFileSync(path.join(f.options.directory, "events/sdk.jsonl"))).toEqual(Buffer.concat([bytes, next]));
});

test("rewritten transcripts retain prior generations and corrupt or missing durable chunks reject recovery", () => {
  const f = fixture(), original = line(user("original")); fs.writeFileSync(f.source, original); f.capture.scan();
  fs.writeFileSync(f.source, line(user("replacement"))); f.capture.scan();
  const manifest = f.capture.verify(); expect(manifest.history).toHaveLength(1);
  const out = path.join(f.root, "export"); f.capture.exportTo(out);
  expect(fs.readFileSync(path.join(out, "history/0/claude/projects/-workspace", `${f.options.sessionId}.jsonl`), "utf8")).toBe(original);
  fs.unlinkSync(path.join(f.options.directory, "chunks", manifest.history[0].chunks[0].sha256));
  expect(() => new NativeCapture(f.options)).toThrow();
});

test("missing children, unmatched calls and a live or failed producer cannot yield complete capture", () => {
  const f = fixture(); fs.writeFileSync(f.source, line({ type: "assistant", message: { content: [{ type: "tool_use", id: "pending", name: "Bash" }] } }) + line({ type: "user", toolUseResult: { status: "async_launched", agentId: "native-child" }, message: { content: [] } }));
  const manifest = f.capture.finish({ ...finish, processStopped: false, successfulResult: false, expectedAgents: ["missing"] });
  expect(manifest.status).toBe("incomplete");
  expect(manifest.issues).toContain("producer_still_running");
  expect(manifest.issues).toContain("successful_result_missing");
  expect(manifest.issues).toContain("child_transcript_missing:missing");
  expect(manifest.issues).toContain("child_transcript_missing:native-child");
  expect(manifest.issues.some((issue) => issue.startsWith("pending_tools:"))).toBe(true);
});

test("append scans keep storage proportional to referenced chunks, while invalid UTF-8 remains incomplete", () => {
  const f = fixture(); fs.writeFileSync(f.source, line(user("first")));
  for (let turn = 0; turn < 8; turn++) { fs.appendFileSync(f.source, line(user(`turn-${turn}`))); f.capture.scan(); }
  expect(fs.readdirSync(path.join(f.options.directory, "chunks"))).toHaveLength(1);
  fs.appendFileSync(f.source, Buffer.concat([Buffer.from('{"message":{"content":"'), Buffer.from([0xff]), Buffer.from('"}}\n')]));
  expect(f.capture.finish(finish).status).toBe("incomplete");
  expect(f.capture.verify().files[0].invalidLines).toBeGreaterThan(0);
});

test("owner, source, version and transcript symlink changes fail closed", () => {
  const f = fixture();
  expect(() => new NativeCapture({ ...f.options, owner: "actor-b" })).toThrow("identity mismatch");
  expect(() => new NativeCapture({ ...f.options, producerVersion: "different" })).toThrow("identity mismatch");
  expect(() => new NativeCapture({ ...f.options, configDir: f.root })).toThrow("identity mismatch");
  const secret = path.join(f.root, "secret"); fs.writeFileSync(secret, "private"); fs.symlinkSync(secret, f.source);
  expect(() => f.capture.scan()).toThrow("symlinks");
  expect(f.capture.verify().files).toHaveLength(0);
});

test("quality distinguishes human candidates, synthetic compaction and notifications, opaque reasoning and unknown native semantics without rewriting them", () => {
  const f = fixture();
  const original = line(user("human")) + line(user("human"))
    + line({ ...user("compact"), isCompactSummary: true })
    + line({ ...user("notice"), message: { content: "<task-notification>background result</task-notification>" } })
    + line({ type: "system", subtype: "compact_boundary", uuid: "boundary" })
    + line({ type: "assistant", uuid: "answer", message: { content: [{ type: "thinking", thinking: "exposed", signature: "sig" }, { type: "redacted_thinking", data: "opaque" }, { type: "future_block", payload: { preserve: true } }] } })
    + line({ type: "future_record", payload: { preserve: true } });
  fs.writeFileSync(f.source, original);
  const manifest = f.capture.finish(finish);
  expect(manifest.status).toBe("complete");
  expect(manifest.qc).toMatchObject({ humanPromptCandidates: 1, syntheticUserRecords: 2, compactionRecords: 2, exposedThinkingBlocks: 1, opaqueThinkingBlocks: 1, unknownRecordTypes: ["future_record"], unknownBlockTypes: ["future_block"], reviewRequired: true });
  const out = path.join(f.root, "export"); f.capture.exportTo(out);
  expect(fs.readFileSync(path.join(out, "claude/projects/-workspace", `${f.options.sessionId}.jsonl`), "utf8")).toBe(original);
});

test("orphan results and conflicting execution identities remain captured but cannot be called complete", () => {
  const f = fixture();
  const original = line({ type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", id: "same", name: "Read", input: { file_path: "/one" } }] } })
    + line({ type: "assistant", uuid: "b", message: { content: [{ type: "tool_use", id: "same", name: "Read", input: { file_path: "/two" } }] } })
    + line({ type: "user", uuid: "c", message: { content: [{ type: "tool_result", tool_use_id: "orphan", content: "not fabricated" }] } });
  fs.writeFileSync(f.source, original);
  const manifest = f.capture.finish(finish);
  expect(manifest.status).toBe("incomplete");
  expect(manifest.issues.some((issue) => issue.startsWith("orphan_results:"))).toBe(true);
  expect(manifest.issues.some((issue) => issue.startsWith("conflicting_tool_identity:"))).toBe(true);
  const out = path.join(f.root, "export"); f.capture.exportTo(out);
  expect(fs.readFileSync(path.join(out, "claude/projects/-workspace", `${f.options.sessionId}.jsonl`), "utf8")).toBe(original);
});

function checkReplay(script: string): void {
  const adapter = fileURLToPath(new URL("../../../../tools/claude-native/verify.py", import.meta.url));
  const result = spawnSync("python3", ["-c", "import importlib.util, sys\nspec=importlib.util.spec_from_file_location('native_verify',sys.argv[1])\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n" + script, adapter], { encoding: "utf8" });
  expect({ status: result.status, error: result.stderr }).toEqual({ status: 0, error: "" });
}

test("native replay preserves command and hook cwd, reports unobserved shell evidence as soft, and never promotes ran-only or missing coverage", () => {
  checkReplay(`
import subprocess, types
seen=[]
def run(argv, **kwargs):
    seen.append(argv)
    return subprocess.CompletedProcess(argv,0,b'ok\\n',b'')
m.subprocess.run=run
call={'id':'one','tool':'Bash','input':{'command':'sudo -n printf ok'},'native_cwd':'/outside/workspace','status':'completed','meta':{'native_tool_result':{'stdout':'ok','stderr':''}}}
out=m.native_bash(types.SimpleNamespace(classify=lambda cmd:'command'),'container',call,{})
assert len(seen)==1 and seen[0][-1]=='sudo -n printf ok'
assert seen[0][seen[0].index('-w')+1]=='/outside/workspace'
assert out['outcome']=='diverge-soft' and out['actual_shell_argv_observed'] is False
assert out['numeric_recorded_exit'] is None
assert m.replay_verdict({'per_call':[['one','match']]},{},[call])==('VERIFIED',True,[])
assert m.replay_verdict({'per_call':[['one','diverge-soft']]},{},[call])[0]=='VERIFIED_WITH_SOFT_DIFFS'
assert m.replay_verdict({'per_call':[['one','tool-worked']]},{},[call])[:2]==('TOOLS_RAN',False)
assert m.replay_verdict({'per_call':[]},{},[call])[:2]==('UNVERIFIED',False)
assert m.replay_verdict({'per_call':[['one','match']]},{'/workspace':['lost']},[call])[:2]==('DIFFERS',False)
`);
});

test("native literal replay never invents redacted bytes or loosely matches edits", () => {
  checkReplay(`
import json, pathlib, subprocess, tempfile
with tempfile.TemporaryDirectory() as directory:
    file=pathlib.Path(directory)/'example.py'
    content='@toolkit.register(\\ncredentials: [credential, ...current.credentials]\\n[REDACTED]\\n'
    result=subprocess.run([sys.executable,'-c',m.NATIVE_EDIT],input=json.dumps({'tool':'Write','input':{'file_path':str(file),'content':content}}).encode(),capture_output=True)
    assert result.returncode==0 and file.read_text()==content
    result=subprocess.run([sys.executable,'-c',m.NATIVE_EDIT],input=json.dumps({'tool':'Edit','input':{'file_path':str(file),'old_string':'@toolkit. register(','new_string':'invented'}}).encode(),capture_output=True)
    assert result.returncode!=0 and file.read_text()==content
    result=subprocess.run([sys.executable,'-c',m.NATIVE_EDIT],input=json.dumps({'tool':'Edit','input':{'file_path':str(file),'old_string':'[REDACTED]','new_string':'literal placeholder in source'}}).encode(),capture_output=True)
    assert result.returncode==0 and file.read_text()==content.replace('[REDACTED]','literal placeholder in source')
`);
});

test("native replay derives executions from preserved generations and rejects result identities without calls", () => {
  checkReplay(`
import io, json, zipfile
def lines(items): return ''.join(json.dumps(x)+'\\n' for x in items)
tool={'id':'one','type':'tool_use','name':'Write','input':{'file_path':'/workspace/x','content':'original'}}
result={'type':'tool_result','tool_use_id':'one','content':'written'}
events=[{'type':'assistant','uuid':'a','message':{'content':[tool]}},{'type':'user','uuid':'b','message':{'content':[result]}}]
hooks=[{'time':'2026-01-01T00:00:00Z','turn':1,'input':{'hook_event_name':kind,'tool_use_id':'one','tool_name':'Write','tool_input':tool['input'],'cwd':'/workspace'}} for kind in ('PreToolUse','PostToolUse')]
file='claude/projects/-workspace/root.jsonl'
manifest={'files':[{'path':file}],'history':[{'path':file,'generation':0}]}
def bundle(records):
    data=io.BytesIO()
    with zipfile.ZipFile(data,'w') as z:
        z.writestr('events/hooks.jsonl',lines(hooks));z.writestr(file,lines([{'type':'user','message':{'content':'compacted'}}]));z.writestr('history/0/'+file,lines(records))
    return zipfile.ZipFile(data)
with bundle(events) as z:
    calls=m.calls_from(z,{'id':'root'},manifest)
    assert len(calls)==1 and calls[0]['input']==tool['input']
    assert calls[0]['source']['path'].startswith('history/0/')
with bundle(events+[{'type':'user','message':{'content':[dict(result,tool_use_id='orphan')]}}]) as z:
    try: m.calls_from(z,{'id':'root'},manifest)
    except ValueError as error: assert 'complete set' in str(error)
    else: raise AssertionError('orphan result accepted')
`);
});

test("native replay keeps corroborated forced Agent model omission explicit and soft; other differences fail closed", () => {
  checkReplay(`
import copy, io, json, zipfile
def lines(rows): return ''.join(json.dumps(row)+'\\n' for row in rows).encode()
model='claude-opus-fixture'
session={'id':'root','owner':'owner','workspaceId':'workspace','model':model,'sdkVersion':'0.3.306','claudeVersion':'2.1.306','base':{'image':'sha256:base'},'authorization':{'upstreamModel':model}}
contract={'schema':1,'sessionId':'root','owner':'owner','workspaceId':'workspace','model':model,'execution':{'baseImage':'sha256:base','kind':'docker','os':'linux','shell':'/bin/bash','workingDirectory':'/workspace'},'harness':{'name':'claude-code','sdkVersion':'0.3.306','claudeVersion':'2.1.306','controllerSha256':'fd1d3a901953f38fc866d6ce62ec5f80ef247f878d029ae47bb581832b26ab00'},'capture':{'scope':'managed-inference','modelIsolation':'exact'}}
session['contract']=contract;session['contractSha256']=m.sha(json.dumps(contract,separators=(',',':')).encode())
journal=[{'schema':1,'sessionId':'root','type':'request','requestId':'r','route':'messages','requestedModel':model,'resolvedModel':model,'contractSha256':session['contractSha256']},{'schema':1,'sessionId':'root','type':'provider_identity','requestId':'r','requestedModel':model,'resolvedModel':model,'providerModel':model,'source':'response-body'},{'schema':1,'sessionId':'root','type':'response','requestId':'r','status':200,'completed':True,'streamComplete':True,'identity':'reported','providerModels':[model]}]
session['modelIsolation']={'status':'observed','expectedModel':model,'resolvedModel':model,'observedModels':[model],'evidenceSha256':m.sha(lines(journal)),'evidenceBytes':len(lines(journal))}
requested={'description':'check','prompt':'preserve exactly','subagent_type':'general-purpose','model':'haiku'}
effective={k:v for k,v in requested.items() if k!='model'}
tool={'type':'tool_use','id':'one','name':'Agent','input':requested}
result={'type':'tool_result','tool_use_id':'one','content':'launched'}
native={'status':'async_launched','agentId':'child','resolvedModel':model}
events=[{'type':'assistant','uuid':'a','message':{'content':[tool]}},{'type':'user','uuid':'b','message':{'content':[result]},'toolUseResult':native}]
hooks=[{'time':'2026-01-01T00:00:00Z','turn':1,'input':{'hook_event_name':kind,'tool_use_id':'one','tool_name':'Agent','tool_input':copy.deepcopy(effective),'cwd':'/workspace'}} for kind in ('PreToolUse','PostToolUse')]
hooks[1]['input']['tool_response']=copy.deepcopy(native)
sdk=[dict(events[0],session_id='root'),{'type':'user','message':{'content':[result]},'tool_use_result':native},{'type':'assistant','parent_tool_use_id':'one','agent_id':'child','message':{'model':model,'content':[{'type':'text','text':'done'}]}}]
file='claude/projects/-workspace/root.jsonl'
base={'session':session,'events':events,'hooks':hooks,'sdk':sdk,'journal':journal}
def calls(data):
    buf=io.BytesIO();stream=lines(data['sdk'])
    manifest={'files':[{'path':file},{'path':'events/sdk.jsonl','sha256':m.sha(stream),'bytes':len(stream)}]}
    if data.get('bad_sdk_hash'): manifest['files'][1]['sha256']='0'*64
    if data.get('unmanifested_sdk'): manifest['files'].pop()
    with zipfile.ZipFile(buf,'w') as z:
        z.writestr(file,lines(data['events']));z.writestr('events/hooks.jsonl',lines(data['hooks']))
        if not data.get('missing_sdk'): z.writestr('events/sdk.jsonl',stream)
        z.writestr('policy/contract.json',json.dumps({'contract':data['session']['contract'],'sha256':data['session']['contractSha256']}))
        z.writestr('policy/model-requests.jsonl',lines(data['journal']))
    with zipfile.ZipFile(buf) as z: return m.calls_from(z,data['session'],manifest)
before=copy.deepcopy(base)
accepted=calls(base);call=accepted[0]
assert base==before and call['input']==requested and call['native_effective_input']==effective
assert call['native_input_normalization']['requested_input']['model']=='haiku'
assert call['native_input_normalization']['strict_verified'] is False
assert all(call['native_input_normalization']['sdk_witnesses'].values())
selected=accepted+[{'id':'write'}];replay={'per_call':[['one','subagent'],['write','match']]}
assert m.replay_verdict(replay,{},selected)==('VERIFIED_WITH_SOFT_DIFFS',True,[])
assert m.replay_verdict(replay,{'/workspace':['changed']},selected)[0]=='DIFFERS'
assert m.replay_verdict({'per_call':[['one','subagent']]},{},selected)[0]=='UNVERIFIED'
def reject(change):
    data=copy.deepcopy(base);change(data)
    try: calls(data)
    except ValueError: pass
    else: raise AssertionError('uncorroborated or tampered omission accepted')
for field in ('prompt','description','subagent_type','extra'):
    reject(lambda d,field=field:d['hooks'][0]['input']['tool_input'].update({field:'altered'}))
reject(lambda d:d['hooks'][0]['input'].update(tool_name='Task'))
reject(lambda d:d['hooks'][1]['input']['tool_input'].update(model='haiku'))
reject(lambda d:d['hooks'][1]['input']['tool_input'].update(prompt='altered'))
reject(lambda d:d['hooks'][1]['input']['tool_response'].update(resolvedModel='haiku'))
reject(lambda d:d['hooks'][1]['input'].update(hook_event_name='PostToolUseFailure'))
reject(lambda d:d['session']['contract']['harness'].update(controllerSha256='0'*64))
reject(lambda d:d['session'].update(sdkVersion='future'))
reject(lambda d:d['session'].pop('modelIsolation'))
reject(lambda d:d['journal'][1].update(providerModel='haiku'))
reject(lambda d:d.update(sdk=[]))
reject(lambda d:d.update(sdk=d['sdk'][:-1]))
reject(lambda d:d['sdk'][2]['message'].update(model='haiku'))
reject(lambda d:d['sdk'][2].update(agent_id='wrong-child'))
reject(lambda d:d['sdk'][0].update(session_id='another-session'))
reject(lambda d:d['sdk'][1].update(tool_use_result={}))
reject(lambda d:d.update(sdk=[dict(d['sdk'][0],message={'content':[dict(tool,input=dict(requested,model='sonnet'))]})]+d['sdk'][1:]))
for flag in ('missing_sdk','unmanifested_sdk','bad_sdk_hash'): reject(lambda d,flag=flag:d.update({flag:True}))
# Exact inputs retain the existing path without requiring normalization witnesses.
exact=copy.deepcopy(base)
for hook in exact['hooks']: hook['input']['tool_input']=copy.deepcopy(requested)
assert 'native_input_normalization' not in calls(exact)[0]
`);
});

test("model provenance is checked independently of replay and never inferred for legacy or mixed-model evidence", () => {
  checkReplay(`
import copy, io, json, zipfile
session={'id':'session','owner':'owner','workspaceId':'workspace','model':'claude-opus-fixture','sdkVersion':'sdk','claudeVersion':'cli','base':{'image':'sha256:base'},'authorization':{'upstreamModel':'claude-opus-fixture'}}
contract={'schema':1,'sessionId':'session','owner':'owner','workspaceId':'workspace','model':session['model'],'execution':{'baseImage':'sha256:base','kind':'docker','os':'linux','shell':'/bin/bash','workingDirectory':'/workspace'},'harness':{'name':'claude-code','sdkVersion':'sdk','claudeVersion':'cli'},'capture':{'scope':'managed-inference','modelIsolation':'exact'}}
session['contract']=contract;session['contractSha256']=m.sha(json.dumps(contract,separators=(',',':')).encode())
resolved=session['authorization']['upstreamModel']
events=[{'type':'request','requestId':'r','route':'messages','requestedModel':session['model'],'resolvedModel':resolved,'contractSha256':session['contractSha256']},{'type':'provider_identity','requestId':'r','requestedModel':session['model'],'resolvedModel':resolved,'providerModel':resolved,'source':'response-body'},{'type':'response','requestId':'r','status':200,'completed':True,'streamComplete':True,'identity':'reported','providerModels':[resolved]}]
def bundle(records):
    data=io.BytesIO();raw=''.join(json.dumps(dict(schema=1,sessionId='session',**x))+'\\n' for x in records).encode()
    session['modelIsolation']={'status':'observed','expectedModel':session['model'],'resolvedModel':resolved,'observedModels':[resolved],'evidenceSha256':m.sha(raw),'evidenceBytes':len(raw)}
    with zipfile.ZipFile(data,'w') as z:
        z.writestr('policy/contract.json',json.dumps({'contract':contract,'sha256':session['contractSha256']}));z.writestr('policy/model-requests.jsonl',raw)
    return zipfile.ZipFile(data)
with bundle(events) as z:
    assert m.model_evidence(z,session)['eligible'] is True
    session['authorization']['upstreamModel']='claude-haiku-fixture'
    session['modelIsolation']['resolvedModel']='claude-haiku-fixture'
    assert m.model_evidence(z,session)['blockers']==['bound_upstream_model_mismatch']
    session['authorization']['upstreamModel']=resolved
    session['modelIsolation']['resolvedModel']=resolved
    session['modelIsolation']['evidenceSha256']='0'*64
    assert m.model_evidence(z,session)['status']=='invalid'
mixed=copy.deepcopy(events);mixed[1]['providerModel']='another-model'
with bundle(mixed) as z:
    result=m.model_evidence(z,session)
    assert result['status']=='invalid' and not result['eligible']
with bundle(events[:-1]) as z:
    assert 'model_journal_incomplete' in m.model_evidence(z,session)['blockers']
refreshed=copy.deepcopy(events);refreshed[-1]['authorizationFailures']=[401]
with bundle(refreshed) as z:
    assert m.model_evidence(z,session)['eligible'] is True
unknown=copy.deepcopy(events);unknown.insert(1,{'type':'authorization_retry','requestId':'r','status':401})
with bundle(unknown) as z:
    assert 'unknown_model_event' in m.model_evidence(z,session)['blockers']
with bundle(events) as z:
    assert m.model_evidence(z,{'id':'legacy'})['status']=='legacy_unverified'
`);
});

test("canonical sealed archives resume native uploads, preserve ZIP bytes and keep checkpoint gates independent", async () => {
  const {createHash} = await import("node:crypto");
  const {zstdDecompressSync} = await import("node:zlib");
  const {parseNativeCaptureCapabilities, uploadNativeBundle} = await import("./upload.js");
  const {writeBundleManifest} = await import("./bundle-manifest.js");
  const {zipDirectory} = await import("./zip.js");
  const {ArchiveUploader} = await import("../session-archive/upload.js");
  const {SealStream, sealKeyring, openSealedBuffer} = await import("../session-archive/seal.js");
  const {tarMemberHeader} = await import("../session-archive/pack.js");
  const f = fixture(), nativeDirectory = path.join(f.root, "native-export"), stateDirectory = path.join(f.root, "uploads");
  fs.writeFileSync(f.source, line(user("first"))); f.capture.finish(finish); f.capture.exportTo(nativeDirectory);
  const raw = Buffer.from('+@toolkit.register(\ncredentials = ["value"]\n{"type":"redacted_thinking","data":"opaque"}\n');
  fs.writeFileSync(path.join(nativeDirectory, "literal-evidence.txt"), raw);
  const binding = {sessionId: f.options.sessionId, bindingId: "01928f3e-7c41-7b2a-9d05-4e6f8a1b2c3d", contractHash: "a".repeat(64), engineVersion: "2.1.306"};
  await writeBundleManifest(nativeDirectory, binding, "claude_native");
  const checkpointDirectory = path.join(f.root, "checkpoint"); fs.cpSync(nativeDirectory, checkpointDirectory, {recursive: true});
  const checkpointManifestSha256 = await writeBundleManifest(checkpointDirectory, binding, "claude_checkpoint");
  const checkpointFile = path.join(f.root, "checkpoint.zip"); await zipDirectory(checkpointDirectory, checkpointFile);
  const keyring = sealKeyring([Buffer.alloc(32, 7)]), key = [...keyring.values()][0]!;
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  type Held = {request: import("./upload.js").NativeArchiveCreate; parts: Map<number, Buffer>; uploaded: boolean};
  const held = new Map<string, Held>(); let failPart = true, wrongReceipt = true, rejectNative = false, keyReads = 0, puts = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}});
  const url = (id: string, part: number) => `https://archive-fixture.invalid/${id}/${part}`;
  const uploader = new ArchiveUploader({
    retry: {attempts: 1, sleep: async () => {}},
    request: async (route, init) => {
      if (route === "archives/key") { keyReads++; return json({kid: key.kid, public_key: key.publicRaw.toString("base64"), alg: "X25519-HKDF-SHA256-A256GCM", limits: {max_upload_bytes: null, max_session_bytes: null, claude: options.capabilities}, policy: {all_folders: false, touched_files: false}}); }
      if (route === "archives") {
        const request: import("./upload.js").NativeArchiveCreate = JSON.parse(init.body!);
        expect(request.harness).toBe("claude-code"); expect(request.binding_id).toBe(binding.bindingId);
        expect(request.contract_hash).toBe(binding.contractHash); expect(request.kind).toBe("base");
        expect(request.parent_archive_id).toBeNull(); expect(request.marker).toBe("project"); expect(request).not.toHaveProperty("media_bytes");
        expect(request.content).toBe(request.payload === "claude_native" ? "tar+zstd" : "zip");
        if (request.payload === "claude_native") expect(request).not.toHaveProperty("box_image");
        else expect(request.box_image).toMatch(/^sha256:[0-9a-f]{64}$/);
        if (rejectNative && request.payload === "claude_native") return json({detail: "archive_payload_disabled"}, 409);
        const existing = held.get(request.archive_id);
        if (existing) expect(request).toEqual(existing.request);
        else for (const prior of held.values()) {
          if (prior.request.session_id === request.session_id && prior.request.payload === request.payload) expect(request.sequence).toBeGreaterThan(prior.request.sequence);
        }
        if (existing?.uploaded) return json({archive_id: request.archive_id, status: "uploaded"});
        if (!existing) held.set(request.archive_id, {request, parts: new Map(), uploaded: false});
        const count = Math.ceil(request.size / 128);
        return json({archive_id: request.archive_id, status: "uploading", upload_id: request.archive_id, object_key: request.archive_id, part_size: 128, part_count: count, parts: Array.from({length: count}, (_, i) => ({part_number: i + 1, url: url(request.archive_id, i + 1)}))}, 201);
      }
      const match = /^archives\/([^/]+)\/(parts|complete)$/.exec(route); if (!match) throw new Error("Unexpected archive API route");
      const item = held.get(match[1]!)!;
      if (match[2] === "parts") {
        const wanted: {part_numbers: number[]} = JSON.parse(init.body!);
        return json({archive_id: match[1], parts: wanted.part_numbers.map(n => ({part_number: n, url: url(match[1]!, n)})), uploaded: [...item.parts].map(([n, bytes]) => ({part_number: n, etag: `"${n}"`, size: bytes.length}))});
      }
      const bytes = Buffer.concat([...item.parts].sort(([a], [b]) => a - b).map(([, data]) => data));
      expect(bytes.length).toBe(item.request.size); expect(hash(bytes)).toBe(item.request.sha256);
      item.uploaded = true;
      if (wrongReceipt) { wrongReceipt = false; return json({archive_id: "another-session", status: "uploaded", size: bytes.length}); }
      return json({archive_id: match[1], status: "uploaded", size: bytes.length});
    },
    fetch: async (address, init) => {
      expect(init?.method).toBe("PUT"); expect(init?.headers).toBeUndefined(); puts++;
      if (failPart) { failPart = false; return new Response("", {status: 503}); }
      const [, id, part] = new URL(address).pathname.split("/");
      const bytes = await new Response(init?.body).arrayBuffer(); held.get(id!)!.parts.set(Number(part), Buffer.from(bytes));
      return new Response("", {headers: {etag: `"${part}"`}});
    },
  });
  const options: import("./upload.js").NativeUploadOptions = {
    ...binding, owner: f.options.owner, turn: 1, nativeDirectory, stateDirectory, checkpointFile, checkpointManifestSha256, boxImage: `sha256:${"b".repeat(64)}`,
    capabilities: {schema: 1, native: {enabled: true, max_bytes: 1024 * 1024}, checkpoint: {enabled: false, max_bytes: 1024 * 1024, retention_days: null}},
    driver: {fetchKey: signal => uploader.fetchKey(signal), upload: (job, persist, signal) => uploader.upload(job, persist, signal), sealer: options => new SealStream(options), tarHeader: tarMemberHeader},
  };
  expect(parseNativeCaptureCapabilities(options.capabilities)).toEqual(options.capabilities);
  for (const invalid of [undefined, {schema: 1}, {...options.capabilities, schema: 2},
    {...options.capabilities, native: {enabled: true, max_bytes: 0}},
    {...options.capabilities, checkpoint: {enabled: false, max_bytes: 1024 * 1024}},
    {...options.capabilities, checkpoint: {...options.capabilities.checkpoint, enabled: "false"}}]) {
    expect(parseNativeCaptureCapabilities(invalid)).toBeNull();
  }
  options.capabilities.native.max_bytes = 1;
  const nativeCap = await uploadNativeBundle(options);
  expect(nativeCap.native.code).toBe("archive_too_large"); expect(held.size).toBe(0); expect(puts).toBe(0);
  if (!nativeCap.native.bytes || !nativeCap.native.plainBytes) throw new Error("Missing retained sealed job");
  expect(nativeCap.native.bytes).toBeGreaterThan(nativeCap.native.plainBytes);
  options.capabilities.native.max_bytes = nativeCap.native.plainBytes;
  expect((await uploadNativeBundle(options)).native.code).toBe("archive_too_large"); expect(held.size).toBe(0);
  options.capabilities.native.max_bytes = nativeCap.native.bytes;
  const interrupted = await uploadNativeBundle(options);
  expect(interrupted.native.status).toBe("pending"); expect(interrupted.checkpoint.status).toBe("disabled"); expect(held.size).toBe(1);
  expect(interrupted.native.archiveId).toBe(nativeCap.native.archiveId);
  const mismatchedReceipt = await uploadNativeBundle(options);
  expect(mismatchedReceipt.native.status).toBe("pending"); expect(mismatchedReceipt.native.code).toBe("invalid completion receipt");
  const resumed = await uploadNativeBundle(options);
  expect(resumed.status).toBe("uploaded"); expect(resumed.native.archiveId).toBe(interrupted.native.archiveId);
  expect(resumed.native.sha256).toBe(interrupted.native.sha256); expect(keyReads).toBe(1);
  const native = held.get(resumed.native.archiveId!)!;
  const sealed = Buffer.concat([...native.parts].sort(([a], [b]) => a - b).map(([, bytes]) => bytes));
  const plaintext = await openSealedBuffer(sealed, keyring), tar = zstdDecompressSync(plaintext);
  expect(hash(plaintext)).toBe(native.request.plain_sha256); expect(plaintext.length).toBe(native.request.plain_size);
  expect(tar.subarray(0, 100).toString("utf8").split("\0")[0]).toBe("__omnirush__/manifest.json");
  expect(tar.includes(raw)).toBe(true);
  const beforeCapPuts = puts;
  options.capabilities.checkpoint = {enabled: true, max_bytes: 1, retention_days: 3};
  const capped = await uploadNativeBundle(options);
  expect(capped.status).toBe("partial"); expect(capped.native.status).toBe("uploaded"); expect(capped.checkpoint.code).toBe("archive_too_large");
  expect(puts).toBe(beforeCapPuts); expect(fs.readFileSync(path.join(nativeDirectory, "literal-evidence.txt"))).toEqual(raw);
  options.capabilities.checkpoint.max_bytes = fs.statSync(checkpointFile).size;
  const sealedCheckpointCap = await uploadNativeBundle(options);
  expect(sealedCheckpointCap.checkpoint.code).toBe("archive_too_large"); expect(puts).toBe(beforeCapPuts); expect(held.size).toBe(1);
  if (!sealedCheckpointCap.checkpoint.bytes) throw new Error("Missing retained checkpoint seal");
  expect(sealedCheckpointCap.checkpoint.bytes).toBeGreaterThan(options.capabilities.checkpoint.max_bytes);
  options.capabilities.checkpoint.max_bytes = sealedCheckpointCap.checkpoint.bytes;
  const completed = await uploadNativeBundle(options); expect(completed.checkpoint.status).toBe("uploaded"); expect(held.size).toBe(2);
  expect(completed.checkpoint.archiveId).toBe(sealedCheckpointCap.checkpoint.archiveId);
  const checkpoint = held.get(completed.checkpoint.archiveId!)!;
  expect(checkpoint.request.sequence).toBe(0); expect(native.request.sequence).toBe(0); expect(checkpoint.request.content).toBe("zip");
  const zipSeal = Buffer.concat([...checkpoint.parts].sort(([a], [b]) => a - b).map(([, bytes]) => bytes));
  await expect(openSealedBuffer(zipSeal, keyring)).rejects.toThrow("bad_header");
  const zip = await openSealedBuffer(zipSeal, keyring, {expectedContent: "zip"});
  expect(zip).toEqual(fs.readFileSync(checkpointFile)); expect(hash(zip)).toBe(checkpoint.request.plain_sha256);
  fs.appendFileSync(path.join(nativeDirectory, "literal-evidence.txt"), "changed");
  const inconsistent = await uploadNativeBundle(options); expect(inconsistent.native.status).toBe("pending"); expect(inconsistent.checkpoint.status).toBe("uploaded");
  expect(inconsistent.native.code).toBe("archive_manifest_members_mismatch");
  expect(JSON.parse(fs.readFileSync(path.join(stateDirectory, "last-upload.json"), "utf8")).native.code).toBe("archive_manifest_members_mismatch");
  expect(held.size).toBe(2); expect(fs.existsSync(checkpointFile)).toBe(true);
  options.capabilities.native.max_bytes = 1024 * 1024;
  await writeBundleManifest(nativeDirectory, binding, "claude_native"); rejectNative = true;
  const disabled = await uploadNativeBundle(options); expect(disabled.native.status).toBe("disabled"); expect(disabled.native.code).toBe("archive_payload_disabled");
  expect(disabled.checkpoint.status).toBe("uploaded"); expect(held.size).toBe(2);
  expect(disabled.native.sequence).toBe(1);
  rejectNative = false; fs.appendFileSync(path.join(nativeDirectory, "literal-evidence.txt"), "next snapshot");
  await writeBundleManifest(nativeDirectory, binding, "claude_native");
  const next = await uploadNativeBundle(options);
  expect(next.native.status).toBe("uploaded"); expect(next.native.sequence).toBe(2); expect(held.size).toBe(3);
  expect(next.checkpoint.archiveId).toBe(completed.checkpoint.archiveId);
  expect(fs.readFileSync(path.join(stateDirectory, "upload-events.jsonl"), "utf8")).toContain("archive_manifest_members_mismatch");
});

function savedRuntimeFixture(access?: () => Promise<{owner: string; capabilities?: string[]}>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-offline-"))); roots.push(root);
  const owner = "local-owner", id = "00000000-0000-4000-8000-000000000001";
  const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(root, hash(owner), id); fs.mkdirSync(path.join(dir, "images"), {recursive: true});
  const image = Buffer.from("saved environment fixture"); fs.writeFileSync(path.join(dir, "images/base.tar.gz"), image);
  const session = {schema: 1, id, owner, workspaceId: "workspace", surface: "gui", model: MODEL, sdkVersion: "legacy", claudeVersion: CLAUDE_VERSION,
    createdAt: new Date(0).toISOString(), container: `omnirush-claude-${id}`, base: {image: "sha256:" + "a".repeat(64), file: "images/base.tar.gz", sha256: hash(image), bytes: image.length},
    turns: [], capture: "incomplete", replay: "unverified", issues: ["interrupted"]};
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify(session));
  const configDir = path.join(dir, "config"), project = path.join(configDir, "projects", "-workspace"); fs.mkdirSync(project, {recursive: true});
  const raw = '{ "type":"future-record", "opaque":"original  bytes" }\n'; fs.writeFileSync(path.join(project, `${id}.jsonl`), raw);
  const collector = new NativeCapture({directory: path.join(dir, "native"), configDir, sessionId: id, owner, producerVersion: CLAUDE_VERSION, surface: "gui", transport: "sdk"});
  collector.finish({type: "finish", processStopped: true, successfulResult: false});
  let accessCalls = 0, grants = 0;
  const runtime = new ClaudeRuntime({fetch: globalThis.fetch, directory: root, surface: "gui", docker: path.join(root, "docker-is-unavailable"),
    access: async () => { accessCalls++; if (access) return access(); throw new Error("account unavailable"); },
    authorize: async () => { grants++; throw new Error("must not mint"); }});
  return {root, dir, id, owner, raw, session, runtime, counts: () => ({accessCalls, grants})};
}

test("offline export reclaims a proven-dead operation owner and preserves the original evidence", async () => {
  const f = savedRuntimeFixture();
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"], {timeout: 5_000});
  expect(dead.status).toBe(0);
  fs.writeFileSync(path.join(f.dir, "operation.lock"), JSON.stringify({pid: dead.pid, nonce: "crashed-owner"}));
  const originalState = fs.readFileSync(path.join(f.dir, "session.json")), originalManifest = fs.readFileSync(path.join(f.dir, "native/manifest.json"));
  const exported = await f.runtime.export(f.id);
  const check = spawnSync("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.read(sys.argv[2]) == sys.argv[3].encode(); assert z.read('images/base.tar.gz') == b'saved environment fixture'", exported, `claude/projects/-workspace/${f.id}.jsonl`, f.raw], {timeout: 5_000});
  expect(check.status).toBe(0);
  expect(fs.readFileSync(path.join(f.dir, "session.json"))).toEqual(originalState);
  expect(fs.readFileSync(path.join(f.dir, "native/manifest.json"))).toEqual(originalManifest);
  expect(fs.existsSync(path.join(f.dir, "operation.lock"))).toBe(false);
  expect((await f.runtime.get(f.id)).id).toBe(f.id);
  expect((await f.runtime.list("workspace")).map(session => session.id)).toEqual([f.id]);
  expect(f.counts()).toEqual({accessCalls: 0, grants: 0});
  await expect(f.runtime.start(f.id, "continue")).rejects.toThrow("account unavailable");
  expect(f.counts().grants).toBe(0);
});

test("offline export refuses live and unknown lock owners without clearing their lock", async () => {
  const f = savedRuntimeFixture(async () => ({owner: "local-owner"}));
  for (const owner of [{pid: process.pid, nonce: "live"}, {pid: 0, nonce: "unknown"}, {pid: "bad"}, {pid: process.pid, nonce: "live", identity: {boot: "unverifiable"}}]) {
    const lock = JSON.stringify(owner); fs.writeFileSync(path.join(f.dir, "operation.lock"), lock);
    await expect(f.runtime.export(f.id)).rejects.toThrow();
    expect(fs.readFileSync(path.join(f.dir, "operation.lock"), "utf8")).toBe(lock);
    expect(fs.existsSync(path.join(f.dir, `${f.id}.zip`))).toBe(false);
  }
});

test("offline lookup rejects owner and session path mismatches, ambiguous IDs and symlink escapes", async () => {
  const f = savedRuntimeFixture(async () => ({owner: f.owner}));
  const state = path.join(f.dir, "session.json"), original = fs.readFileSync(state);
  for (const changed of [{owner: "another-owner"}, {id: "00000000-0000-4000-8000-000000000002"}, {workspaceId: ""}]) {
    fs.writeFileSync(state, JSON.stringify({...f.session, ...changed}));
    await expect(f.runtime.get(f.id)).rejects.toThrow();
  }
  fs.writeFileSync(state, original);
  const outside = path.join(f.root, "outside.json"); fs.renameSync(state, outside); fs.symlinkSync(outside, state);
  await expect(f.runtime.get(f.id)).rejects.toThrow(); fs.unlinkSync(state); fs.renameSync(outside, state);
  const otherRoot = path.join(f.root, "b".repeat(64)); fs.mkdirSync(otherRoot);
  fs.symlinkSync(f.dir, path.join(otherRoot, f.id)); await expect(f.runtime.get(f.id)).rejects.toThrow();
  fs.unlinkSync(path.join(otherRoot, f.id)); fs.cpSync(f.dir, path.join(otherRoot, f.id), {recursive: true});
  await expect(f.runtime.get(f.id)).rejects.toThrow();
  fs.rmSync(otherRoot, {recursive: true});
  fs.writeFileSync(outside, "outside-canary");
  for (const target of [path.join(f.dir, "images", "escape"), path.join(f.dir, `${f.id}.zip.tmp`)]) {
    fs.symlinkSync(outside, target);
    await expect(f.runtime.export(f.id)).rejects.toThrow();
    expect(fs.readFileSync(outside, "utf8")).toBe("outside-canary"); fs.unlinkSync(target);
  }
});

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}

test("shutdown fences startup blocked on access and never mints or starts Docker after access resolves", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-startup-")); roots.push(root);
  const entered = gate<void>(), access = gate<{owner: string; capabilities: string[]}>(); let grants = 0, dockerCalls = 0;
  const runtime = new ClaudeRuntime({fetch: globalThis.fetch, directory: root, surface: "gui", access: () => { entered.resolve(); return access.promise; }, authorize: async () => { grants++; throw new Error("must not mint"); }});
  Reflect.set(runtime, "docker", async () => { dockerCalls++; throw new Error("must not start Docker"); });
  const creation = runtime.create(root, "workspace").then(() => "created", () => "cancelled");
  await entered.promise;
  const shutdown = runtime.shutdown();
  access.resolve({owner: "local-owner", capabilities: ["claude-code"]});
  expect(await creation).toBe("cancelled"); await shutdown;
  expect({grants, dockerCalls}).toEqual({grants: 0, dockerCalls: 0});
  await expect(runtime.prepare()).rejects.toThrow();
});

test("offline export reclaims a dead legacy PID even with account available, but not a live PID", async () => {
  const f = savedRuntimeFixture(async () => ({owner: "local-owner"}));
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"], {timeout: 5_000});
  fs.writeFileSync(path.join(f.dir, "operation.lock"), JSON.stringify({pid: dead.pid, nonce: "dead"}));
  expect(fs.existsSync(await f.runtime.export(f.id))).toBe(true);
  const live = JSON.stringify({pid: process.pid, nonce: "live"}); fs.writeFileSync(path.join(f.dir, "operation.lock"), live);
  await expect(f.runtime.export(f.id)).rejects.toThrow();
  expect(fs.readFileSync(path.join(f.dir, "operation.lock"), "utf8")).toBe(live);
});

test("operation locks distinguish reused PIDs from the live process birth identity", async () => {
  if (process.platform !== "linux") return;
  const f = savedRuntimeFixture(async () => ({owner: "local-owner"}));
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const identity = {host: os.hostname(), boot: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), namespace: fs.readlinkSync("/proc/self/ns/pid"), start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]};
  const lockPath = path.join(f.dir, "operation.lock"), live = JSON.stringify({pid: process.pid, nonce: "live-birth", identity});
  fs.writeFileSync(lockPath, live); await expect(f.runtime.export(f.id)).rejects.toThrow();
  expect(fs.readFileSync(lockPath, "utf8")).toBe(live);
  for (const changed of [{start: String(BigInt(identity.start) - 1n)}, {boot: "00000000-0000-4000-8000-000000000099"}]) {
    fs.writeFileSync(lockPath, JSON.stringify({pid: process.pid, nonce: "previous-birth", identity: {...identity, ...changed}}));
    expect(fs.existsSync(await f.runtime.export(f.id))).toBe(true);
  }
  const unknown = JSON.stringify({pid: process.pid, nonce: "other-namespace", identity: {...identity, namespace: "pid:[unknown]"}});
  fs.writeFileSync(lockPath, unknown); await expect(f.runtime.export(f.id)).rejects.toThrow();
  expect(fs.readFileSync(lockPath, "utf8")).toBe(unknown);
});

async function waitForFixture(file: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (fs.existsSync(file)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Fixture did not reach ${path.basename(file)}`);
}
async function cancellationResult(work: Promise<string>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<string>(resolve => { timer = setTimeout(() => resolve("still-running"), 1_000); })]); }
  finally { clearTimeout(timer); }
}

function startupDockerFixture(stage: "build" | "create" | "cp" | "exec" | "restore") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-docker-fixture-")); roots.push(root);
  const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace);
  const docker = path.join(root, "docker-fixture.mjs"), ready = path.join(root, "ready"), release = path.join(root, "release"), log = path.join(root, "calls.jsonl");
  const runtime = new ClaudeRuntime({fetch: globalThis.fetch, directory: path.join(root, "state"), surface: "gui", docker,
    access: async () => ({owner: "local-owner", capabilities: ["claude-code"]}),
    authorize: async () => { grants++; throw new Error("must not authorize after cancellation"); }});
  let grants = 0;
  const fingerprint = createHash("sha256").update(JSON.stringify(Reflect.get(runtime, "harnessContract").call(runtime))).digest("hex");
  fs.writeFileSync(docker, `#!${process.execPath}
import fs from 'node:fs';
const root=${JSON.stringify(root)}, stage=${JSON.stringify(stage)}, args=process.argv.slice(2);
const state=root+'/container.json', ready=root+'/ready';
fs.appendFileSync(root+'/calls.jsonl',JSON.stringify(args)+'\\n');
const own='c'.repeat(64), foreign='f'.repeat(64), image='sha256:'+'a'.repeat(64);
const pause=async()=>{fs.writeFileSync(ready,JSON.stringify({pid:process.pid,args}));for(let i=0;i<200;i++){if(fs.existsSync(root+'/release'))return;await new Promise(r=>setTimeout(r,10));}process.exit(42);};
if(args[0]==='create'){
 const label=args.find(a=>a.startsWith('org.omnirush.claude.operation='));
 fs.writeFileSync(state,JSON.stringify({Id:own,Config:{Labels:{'org.omnirush.claude.operation':label?.split('=')[1]}},Name:args[args.indexOf('--name')+1]}));
 if(stage==='create')await pause();console.log(own);
}else if(args[0]==='container'&&args[1]==='ls')console.log((fs.existsSync(state)?own+'\\n':'')+foreign);
else if(args[0]==='image'&&args[1]==='ls')console.log(image);
else if(args[1]==='inspect'){
 if(args[0]==='container'&&stage==='restore'&&args[2].startsWith('omnirush-'))await pause();
 if(args[2]===foreign)console.log(JSON.stringify([{Id:foreign,Config:{Labels:{'org.omnirush.claude.operation':'another-operation'}}}]));
 else if(args[2]===own)console.log('['+fs.readFileSync(state,'utf8')+']');
 else console.log(JSON.stringify([{Id:image,Os:'linux',Architecture:'amd64',Config:{Labels:{'org.omnirush.claude.runtime':stage==='build'?'old':${JSON.stringify(fingerprint)}}}}]));
}else if(args[0]==='build'||args[0]===stage)await pause();
else if(args[0]==='commit')console.log(image);
else if(args[0]==='save')fs.writeFileSync(args[args.indexOf('--output')+1],'fixture image archive');
else if(args[0]==='rm'||args[0]==='container'&&args[1]==='rm')fs.rmSync(state,{force:true});
`, {mode: 0o700});
  return {root, workspace, runtime, ready, release, log, grants: () => grants,
    calls: (): string[][] => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : []};
}

for (const stage of ["build", "create", "cp", "exec"] as const) test(`startup request abort kills Docker ${stage}, waits for owned cleanup and never authorizes`, async () => {
  const f = startupDockerFixture(stage), controller = new AbortController();
  const result = f.runtime.create(f.workspace, "workspace", controller.signal).then(() => "created", () => "cancelled");
  try {
    await waitForFixture(f.ready); const witness = JSON.parse(fs.readFileSync(f.ready, "utf8"));
    controller.abort();
    expect(await cancellationResult(result)).toBe("cancelled");
    await f.runtime.shutdown();
    expect(() => process.kill(witness.pid, 0)).toThrow();
    expect(f.grants()).toBe(0);
    expect(fs.existsSync(path.join(f.root, "container.json"))).toBe(false);
    const calls = f.calls();
    expect(calls.some(args => args.includes("/opt/claude/controller.mjs"))).toBe(false);
    expect(calls.filter(args => args.includes("rm")).every(args => args.at(-1) === "c".repeat(64))).toBe(true);
    expect(calls.some(args => args[0] === "commit")).toBe(false);
    const owners = fs.readdirSync(path.join(f.root, "state")).filter(name => /^[a-f0-9]{64}$/.test(name));
    for (const owner of owners) for (const id of fs.readdirSync(path.join(f.root, "state", owner))) expect(fs.existsSync(path.join(f.root, "state", owner, id, "session.json"))).toBe(false);
  } finally { fs.writeFileSync(f.release, "release"); await result; await f.runtime.shutdown(); }
}, 10_000);

test("Stop and shutdown abort pending turn restoration before mint or controller execution", async () => {
  for (const action of ["stop", "shutdown"] as const) {
    const f = startupDockerFixture("restore");
    const session = await f.runtime.create(f.workspace, "workspace");
    const result = f.runtime.start(session.id, "must not run").then(() => "started", () => "cancelled");
    try {
      await waitForFixture(f.ready); const witness = JSON.parse(fs.readFileSync(f.ready, "utf8"));
      const stopping = action === "stop" ? f.runtime.stop(session.id) : f.runtime.shutdown();
      expect(await result).toBe("cancelled"); await stopping;
      expect(() => process.kill(witness.pid, 0)).toThrow();
      expect(f.grants()).toBe(0);
      expect(f.calls().some(args => args.includes("/opt/claude/controller.mjs"))).toBe(false);
      expect((await f.runtime.get(session.id)).turns).toEqual([]);
    } finally { fs.writeFileSync(f.release, "release"); await result; await f.runtime.shutdown(); }
  }
}, 10_000);

test("shutdown drains pending sandbox creation and fences subsequent startup", async () => {
  const f = startupDockerFixture("create");
  const result = f.runtime.create(f.workspace, "workspace").then(() => "created", () => "cancelled");
  try {
    await waitForFixture(f.ready); const witness = JSON.parse(fs.readFileSync(f.ready, "utf8"));
    await f.runtime.shutdown();
    expect(await result).toBe("cancelled");
    expect(() => process.kill(witness.pid, 0)).toThrow();
    expect(fs.existsSync(path.join(f.root, "container.json"))).toBe(false);
    const before = f.calls();
    await expect(f.runtime.prepare()).rejects.toThrow("shutting down");
    await expect(f.runtime.create(f.workspace, "workspace")).rejects.toThrow("shutting down");
    expect(f.calls()).toEqual(before); expect(f.grants()).toBe(0);
  } finally { fs.writeFileSync(f.release, "release"); await result; await f.runtime.shutdown(); }
}, 10_000);

test("broker cancellation during account access prevents both mint and provider calls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-broker-abort-")); roots.push(root);
  const access = gate<{owner: string}>(), entered = gate<void>(), controller = new AbortController();
  let grants = 0, providerCalls = 0;
  const relay = Bun.serve({hostname: "127.0.0.1", port: 0, fetch() { providerCalls++; return Response.json({type: "message", model: MODEL, content: [], stop_reason: "end_turn"}); }});
  const id = "00000000-0000-4000-8000-000000000001", contractSha256 = "a".repeat(64);
  const runtime = new ClaudeRuntime({fetch: globalThis.fetch, directory: root, surface: "gui", access: () => { entered.resolve(); return access.promise; },
    authorize: async () => { grants++; return {owner: "owner", sessionId: id, model: MODEL, upstreamModel: MODEL, client: "desktop/3.7.5", baseUrl: `http://127.0.0.1:${relay.port}`, token: "orc_" + "a".repeat(43), contractSha256}; }});
  const broker = await Reflect.get(runtime, "broker").call(runtime, {owner: "owner", id, model: MODEL, workspaceId: "workspace", contract: {}, contractSha256, turns: []}, () => {}, controller.signal);
  try {
    const response = fetch(broker.baseUrl.replace("host.docker.internal", "127.0.0.1") + "/v1/messages", {method: "POST", headers: {authorization: `Bearer ${broker.token}`, "content-type": "application/json"}, body: JSON.stringify({model: MODEL, messages: [], max_tokens: 1}), signal: AbortSignal.timeout(3_000)});
    await entered.promise; controller.abort(); access.resolve({owner: "owner"});
    await (await response).arrayBuffer();
    expect({grants, providerCalls}).toEqual({grants: 0, providerCalls: 0});
  } finally { access.resolve({owner: "owner"}); await broker.close(); relay.stop(true); }
});

test("Claude routes export offline only within the requested workspace and pass startup request cancellation", async () => {
  const {registerClaudeRoutes} = await import("./routes.js");
  const {matchRoute} = await import("../routes/registry.js");
  const f = savedRuntimeFixture(), routes: import("../routes/registry.js").Route[] = [];
  let ownerChecks = 0;
  registerClaudeRoutes({routes, runtime: f.runtime, workspace: async ctx => ({id: ctx.params.id, name: "Fixture", path: f.root, preset: "default", workspaceType: "local"}),
    owner: () => { ownerChecks++; }, writable: () => {}, upload: async () => { throw new Error("not used"); }});
  const call = (request: Request) => {
    const route = matchRoute(routes, request.method, new URL(request.url).pathname); if (!route) throw new Error("route not found");
    return Reflect.apply(route.handler, undefined, [{request, params: route.params}]);
  };
  const response: Response = await call(new Request(`http://localhost/workspace/workspace/claude/sessions/${f.id}/export`, {method: "POST"}));
  expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("application/zip");
  expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  await expect(call(new Request(`http://localhost/workspace/another-workspace/claude/sessions/${f.id}/export`, {method: "POST"}))).rejects.toThrow("Session not found in this workspace");
  expect(f.counts()).toEqual({accessCalls: 0, grants: 0}); expect(ownerChecks).toBe(2);
  const controller = new AbortController(); controller.abort();
  for (const suffix of ["prepare", "sessions", `sessions/${f.id}/turns`]) {
    await expect(call(new Request(`http://localhost/workspace/workspace/claude/${suffix}`, {method: "POST", signal: controller.signal, headers: {"content-type": "application/json"}, body: JSON.stringify({captureConsent: true, prompt: "must not run"})}))).rejects.toThrow();
  }
  expect(f.counts()).toEqual({accessCalls: 0, grants: 0});
});


function guardWorker(f: ReturnType<typeof savedRuntimeFixture>) {
  const script = path.join(f.root, "guard-worker.mjs");
  fs.writeFileSync(script, `
import fs from 'node:fs';
import path from 'node:path';
import {ClaudeRuntime} from ${JSON.stringify(new URL("./runtime.ts", import.meta.url).href)};
const root=${JSON.stringify(f.root)}, dir=${JSON.stringify(f.dir)}, id=${JSON.stringify(f.id)};
const [mode,name='crash']=process.argv.slice(2), guard=path.join(dir,'recovery.lock');
const rename=fs.renameSync, open=fs.openSync, link=fs.linkSync;
const wait=file=>{for(let n=0;n<1000;n++){if(fs.existsSync(file))return;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}throw new Error('bounded fixture wait expired');};
fs.openSync=function(file,...args){const fd=open.call(fs,file,...args);if(mode==='crash-publish'&&file===guard){fs.writeFileSync(path.join(root,'publication.json'),JSON.stringify({empty:fs.statSync(guard).size===0}));process.exit(77);}return fd;};
fs.linkSync=function(from,to){const result=link.call(fs,from,to);if(mode==='crash-operation'&&to===path.join(dir,'operation.lock')){fs.writeFileSync(path.join(root,'operation-publication.json'),fs.readFileSync(to));process.exit(79);}return result;};
fs.renameSync=function(from,to){
 const reaping=from===guard&&path.basename(String(to)).startsWith('.recovery-dead-');
 if(mode==='contend'&&reaping){fs.writeFileSync(path.join(root,'ready-'+name),'ready');wait(path.join(root,'go-'+name));}
 const result=rename.call(fs,from,to);
 if(mode==='crash-reclaim'&&reaping)process.exit(78);
 if(to===guard){
  if(mode==='crash-publish'){fs.writeFileSync(path.join(root,'publication.json'),fs.readFileSync(path.join(guard,'owner.json')));process.exit(77);}
  if(mode==='contend'){fs.writeFileSync(path.join(root,'holding-'+name),fs.readFileSync(path.join(guard,'owner.json')));wait(path.join(root,'release-'+name));}
 }
 return result;
};
const runtime=new ClaudeRuntime({fetch: globalThis.fetch, directory:root,surface:'gui',docker:path.join(root,'no-docker'),access:async()=>{throw new Error('offline');},authorize:async()=>{throw new Error('must not mint');}});
try{const zip=await runtime.export(id);fs.writeFileSync(path.join(root,'result-'+name),JSON.stringify({status:'exported',zip}));}
catch(error){fs.writeFileSync(path.join(root,'result-'+name),JSON.stringify({status:'rejected',message:error.message}));}
`);
  return script;
}
function staleOperation(f: ReturnType<typeof savedRuntimeFixture>) {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {timeout: 5_000});
  expect(child.status).toBe(0);
  const owner = {pid: child.pid, nonce: "dead-operation"};
  fs.writeFileSync(path.join(f.dir, "operation.lock"), JSON.stringify(owner));
  return owner;
}
function seedGuard(f: ReturnType<typeof savedRuntimeFixture>, owner: unknown) {
  const guard = path.join(f.dir, "recovery.lock"); fs.mkdirSync(guard);
  fs.writeFileSync(path.join(guard, "owner.json"), typeof owner === "string" ? owner : JSON.stringify(owner));
  return guard;
}

test("recovery guard crash at publication or reclamation still permits byte-exact offline export", async () => {
  for (const point of ["publication", "reclamation", "operation"]) {
    const f = savedRuntimeFixture(); staleOperation(f); const script = guardWorker(f);
    const state = fs.readFileSync(path.join(f.dir, "session.json")), manifest = fs.readFileSync(path.join(f.dir, "native", "manifest.json"));
    const crash = spawnSync(process.execPath, [script, "crash-publish"], {timeout: 5_000});
    expect(crash.status).toBe(77);
    if (point === "reclamation") {
      const second = spawnSync(process.execPath, [script, "crash-reclaim"], {timeout: 5_000});
      expect(second.status).toBe(78);
    }
    if (point === "operation") {
      const second = spawnSync(process.execPath, [script, "crash-operation"], {timeout: 5_000});
      expect(second.status).toBe(79);
      const published = JSON.parse(fs.readFileSync(path.join(f.root, "operation-publication.json"), "utf8"));
      expect(published.pid).toBe(second.pid); expect(typeof published.nonce).toBe("string");
    }
    const zip = await f.runtime.export(f.id);
    const publication = JSON.parse(fs.readFileSync(path.join(f.root, "publication.json"), "utf8"));
    expect(publication.pid).toBe(crash.pid); expect(typeof publication.nonce).toBe("string");
    expect(publication).not.toHaveProperty("empty");
    if (process.platform === "linux") expect(publication.identity.start).toMatch(/^\d+$/);
    expect(fs.readFileSync(path.join(f.dir, "session.json"))).toEqual(state);
    expect(fs.readFileSync(path.join(f.dir, "native", "manifest.json"))).toEqual(manifest);
    const check = spawnSync("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.read(sys.argv[2]) == sys.argv[3].encode()", zip, `claude/projects/-workspace/${f.id}.jsonl`, f.raw], {timeout: 5_000});
    expect(check.status).toBe(0); expect(f.counts()).toEqual({accessCalls: 0, grants: 0});
    expect(fs.existsSync(path.join(f.dir, "recovery.lock"))).toBe(false);
    expect(fs.readdirSync(f.dir).some(name => name.startsWith(".recovery-dead-"))).toBe(true);
  }
});

test("recovery guard refuses live and unknown owners, including legacy empty files, without changing either lock", async () => {
  const f = savedRuntimeFixture(); staleOperation(f);
  const operation = fs.readFileSync(path.join(f.dir, "operation.lock"));
  for (const owner of [{pid: process.pid, nonce: "live"}, {pid: 0, nonce: "unknown"}, {pid: process.pid, nonce: "unknown-birth", identity: {boot: "unverifiable"}}, ""]) {
    const guard = seedGuard(f, owner), bytes = fs.readFileSync(path.join(guard, "owner.json"));
    await expect(f.runtime.export(f.id)).rejects.toThrow();
    expect(fs.readFileSync(path.join(guard, "owner.json"))).toEqual(bytes);
    expect(fs.readFileSync(path.join(f.dir, "operation.lock"))).toEqual(operation);
    fs.rmSync(guard, {recursive: true});
  }
  const guard = path.join(f.dir, "recovery.lock"); fs.writeFileSync(guard, "");
  await expect(f.runtime.export(f.id)).rejects.toThrow(); expect(fs.readFileSync(guard).length).toBe(0);
  expect(fs.readFileSync(path.join(f.dir, "operation.lock"))).toEqual(operation);
  fs.unlinkSync(guard); fs.mkdirSync(guard);
  await expect(f.runtime.export(f.id)).rejects.toThrow(); expect(fs.readdirSync(guard)).toEqual([]);
  expect(fs.readFileSync(path.join(f.dir, "operation.lock"))).toEqual(operation);
});

test.skipIf(process.platform !== "linux")("recovery guard distinguishes reused PID birth from live and unknown namespace owners", async () => {
  const f = savedRuntimeFixture(), dead = staleOperation(f);
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const identity = {host: os.hostname(), boot: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), namespace: fs.readlinkSync("/proc/self/ns/pid"), start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]};
  for (const changed of [{}, {namespace: "pid:[unknown]"}]) {
    const guard = seedGuard(f, {pid: process.pid, nonce: "live-or-unknown", identity: {...identity, ...changed}}), bytes = fs.readFileSync(path.join(guard, "owner.json"));
    await expect(f.runtime.export(f.id)).rejects.toThrow();
    expect(fs.readFileSync(path.join(guard, "owner.json"))).toEqual(bytes); fs.rmSync(guard, {recursive: true});
  }
  seedGuard(f, {pid: process.pid, nonce: "reused", identity: {...identity, start: String(BigInt(identity.start) - 1n)}});
  expect(fs.existsSync(await f.runtime.export(f.id))).toBe(true);
  // A dead guard is never permission to remove a separate live operation.
  seedGuard(f, dead); const live = JSON.stringify({pid: process.pid, nonce: "live-operation", identity});
  fs.writeFileSync(path.join(f.dir, "operation.lock"), live);
  await expect(f.runtime.export(f.id)).rejects.toThrow();
  expect(fs.readFileSync(path.join(f.dir, "operation.lock"), "utf8")).toBe(live);
});

test("recovery guard concurrent reclaimers cannot displace the winner's live replacement", async () => {
  const f = savedRuntimeFixture(), dead = staleOperation(f); seedGuard(f, dead);
  const script = guardWorker(f), operation = fs.readFileSync(path.join(f.dir, "operation.lock"));
  const launch = (name: string) => {
    const child = spawn(process.execPath, [script, "contend", name], {stdio: "ignore"});
    const done = new Promise<number | null>(resolve => child.once("exit", resolve));
    return {child, done};
  };
  const a = launch("a"), b = launch("b");
  try {
    await Promise.all([waitForFixture(path.join(f.root, "ready-a")), waitForFixture(path.join(f.root, "ready-b"))]);
    fs.writeFileSync(path.join(f.root, "go-a"), "go"); await waitForFixture(path.join(f.root, "holding-a"));
    const winner = fs.readFileSync(path.join(f.dir, "recovery.lock", "owner.json"));
    expect(JSON.parse(winner.toString()).pid).toBe(a.child.pid);
    fs.writeFileSync(path.join(f.root, "go-b"), "go"); await waitForFixture(path.join(f.root, "result-b"));
    expect(JSON.parse(fs.readFileSync(path.join(f.root, "result-b"), "utf8")).status).toBe("rejected");
    expect(fs.readFileSync(path.join(f.dir, "recovery.lock", "owner.json"))).toEqual(winner);
    expect(fs.readFileSync(path.join(f.dir, "operation.lock"))).toEqual(operation);
    fs.writeFileSync(path.join(f.root, "release-a"), "release"); await waitForFixture(path.join(f.root, "result-a"));
    expect(JSON.parse(fs.readFileSync(path.join(f.root, "result-a"), "utf8")).status).toBe("exported");
    expect(await a.done).toBe(0); expect(await b.done).toBe(0);
    expect(fs.existsSync(path.join(f.dir, "recovery.lock"))).toBe(false);
    expect(fs.existsSync(path.join(f.dir, "operation.lock"))).toBe(false);
  } finally { a.child.kill("SIGKILL"); b.child.kill("SIGKILL"); await Promise.all([a.done, b.done]); }
}, 10_000);
