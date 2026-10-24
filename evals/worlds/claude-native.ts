import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { chrome, desktop, localHost } from "@omnirush/hosts";
import { allocateFreePort, browserScript, evaluateOnSurface, navigate } from "@omnirush/cdp";
import { eventually } from "@omnirush/testkit";
// Electron's executable JavaScript module has no published declaration file.
// @ts-expect-error Tests exercise the actual main-process transfer helper.
import { downloadClaudeArchive } from "../../apps/desktop/electron/binary-transfer.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const execute = promisify(execFile);
export async function claudeNativeWorld() { return createClaudeWorld(false); }
export async function claudeConnectionWorld() { return createClaudeWorld(true); }
async function createClaudeWorld(connectionOnly: boolean) {
  const packaged = !connectionOnly && Boolean(process.env.OMNIRUSH_EVAL_ELECTRON_BINARY);
  const root = mkdtempSync(path.join(tmpdir(), "omnirush-claude-journey-"));
  const log = await fs.open(path.join(root, "server.log"), "a");
  const lab = spawn("bun", ["--conditions=development", "evals/packages/labs/src/claude-runtime-server.ts"], {cwd: repo, env: {...process.env, CLAUDE_LAB_DIR: root, CLAUDE_LAB_INFERENCE_ONLY: packaged ? "1" : "0", CLAUDE_LAB_CONNECTION_ONLY: connectionOnly ? "1" : "0"}, stdio: ["ignore", log.fd, log.fd]});
  const ready: {baseUrl: string; token: string; hostToken: string; workspaceId: string; gateway: string} = await eventually(async () => JSON.parse(await fs.readFile(path.join(root, "ready.json"), "utf8")), {within: 60_000});
  const viteLog = await fs.open(path.join(root, "vite.log"), "a");
  let vite: ChildProcess | undefined;
  let app!: Awaited<ReturnType<typeof chrome>> | Awaited<ReturnType<typeof desktop>>;
  let collaboratorToken = "owt_claude_fixture";
  try {
  if (packaged) {
    app = await desktop({name: "claude-native-packaged", host: localHost(), prepareSharedResources: false,
      profileDir: path.join(root, "electron-profile"), timeoutMs: 90_000,
      env: {OMNIRUSH_RUNTIME_DB: path.join(root, "runtime.sqlite"),
        OMNIRUSH_ACCESS_TOKEN: "device-fixture", OMNIRUSH_REFRESH_TOKEN: "refresh-fixture", OMNIRUSH_GATEWAY_URL: `${ready.gateway}/v1`,
        OMNIRUSH_ELECTRON_START_URL: "", ELECTRON_START_URL: "", OMNIRUSH_AUTO_UPDATE: "0"},
    });
    const connection = await evaluateOnSurface(app, browserScript(async folderPath => {
      const bridge = window.__OMNIRUSH_ELECTRON__;
      if (!bridge || location.protocol !== "file:") throw new Error("The installed-layout renderer/preload did not load");
      const initial = await bridge.invokeDesktop("omnirushServerInfo");
      const response = await fetch(`${initial.baseUrl}/workspaces/local`, {method: "POST", headers: {authorization: `Bearer ${initial.ownerToken}`, "content-type": "application/json"}, body: JSON.stringify({folderPath, name: "Claude fixture", preset: "starter"})});
      if (!response.ok) throw new Error(`Packaged workspace registration failed: ${response.status}`);
      const workspaces = await response.json();
      const workspace = workspaces.workspaces.find((entry: {path: string; id: string}) => entry.path === folderPath);
      if (!workspace) throw new Error("Packaged workspace registration did not return the project");
      await bridge.invokeDesktop("workspaceSetSelected", workspace.id);
      await bridge.invokeDesktop("workspaceSetRuntimeActive", workspace.id);
      const info = await bridge.invokeDesktop("omnirushServerInfo");
      if (!workspace || !info.baseUrl || !info.ownerToken || !info.clientToken) throw new Error("Packaged embedded server did not provide owner and collaborator endpoints");
      location.hash = `/workspace/${workspace.id}/claude`;
      return {baseUrl: info.baseUrl, token: info.ownerToken, clientToken: info.clientToken, workspaceId: workspace.id};
    }, [path.join(root, "project")]));
    Object.assign(ready, connection); collaboratorToken = connection.clientToken;
  } else {
    const port = await allocateFreePort();
    vite = spawn("pnpm", ["--filter", "@omnirush/app", "dev", "--host", "127.0.0.1", "--port", String(port)], {cwd: repo, env: {...process.env, OMNIRUSH_DEV_MODE: "1"}, detached: true, stdio: ["ignore", viteLog.fd, viteLog.fd]});
    const url = `http://127.0.0.1:${port}`;
    await eventually(async () => (await fetch(url)).ok, {within: 60_000, until: value => value});
    app = await chrome({name: "claude-native", host: localHost(), startUrl: url, headless: true});
    await eventually(() => evaluateOnSurface(app, () => location.origin), {within: 30_000, until: origin => origin === url});
    await evaluateOnSurface(app, browserScript((base, token, hostToken) => {
      localStorage.setItem("omnirush.server.urlOverride", base);
      localStorage.setItem("omnirush.server.token", token);
      localStorage.setItem("omnirush.server.hostToken", hostToken);
    }, [ready.baseUrl, ready.token, ready.hostToken]));
    await navigate(app.client, `${url}/workspace/${ready.workspaceId}/claude`);
  }
  } catch (error) {
    await app?.[Symbol.asyncDispose]();
    lab.kill("SIGTERM");
    if (vite?.pid) try { process.kill(-vite.pid, "SIGTERM"); } catch { /* already stopped */ }
    await log.close(); await viteLog.close();
    throw error;
  }
  const request = async (route: string, body?: unknown, token = ready.token, hostToken?: string) => {
    const headers: Record<string, string> = {authorization: `Bearer ${token}`, "content-type": "application/json"};
    if (hostToken) headers["x-omnirush-host-token"] = hostToken;
    const response = await fetch(`${ready.baseUrl}/workspace/${ready.workspaceId}/claude/${route}`, {method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, body: await response.json()};
  };
  let dialogTask: Promise<void> | undefined;
  const initialHostFiles = await fs.readdir(path.join(root, "project"));
  return {app, root, request, packaged, collaboratorToken, initialHostFiles,
    async connectionWitness() { return (await fetch(`${ready.baseUrl}/fixture/witness`)).json(); },
    async connectionControl(body: {hostToken?: string; holdCreate?: boolean; available?: boolean; crashedTurn?: boolean; exportMode?: "stream" | "blocked" | "complete"}) {
      await fetch(`${ready.baseUrl}/fixture/control`, {method: "POST", body: JSON.stringify(body)});
    },
    async publishHostToken(hostToken: string) {
      await evaluateOnSurface(app, browserScript(token => {
        localStorage.setItem("omnirush.server.hostToken", token);
        window.dispatchEvent(new CustomEvent("omnirush-server-settings-changed"));
      }, [hostToken]));
    },
    async navigateConnectionWorkspace(remote: boolean) {
      await evaluateOnSurface(app, browserScript(id => {
        history.pushState(null, "", `/workspace/${id}/claude`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, [remote ? "rem_ws_remote" : ready.workspaceId]));
    },
    async cancelDesktopExport(id: string) {
      if (!packaged || process.platform !== "linux") throw new Error("Native cancellation proof requires packaged Linux Electron/xdotool");
      const transferId = `claude-cancel-${id}`;
      const pending = evaluateOnSurface(app, browserScript(async (baseUrl, token, sessionId, transfer) => {
        const input = {url: `${baseUrl}/workspace/${sessionId.workspaceId}/claude/sessions/${sessionId.id}/export`, headers: {authorization: `Bearer ${token}`}, transferId: transfer};
        try { await window.__OMNIRUSH_ELECTRON__.invokeDesktop("__downloadClaudeArchive", input); return "completed"; }
        catch { return "cancelled"; }
      }, [ready.baseUrl, ready.token, {id, workspaceId: ready.workspaceId}, transferId]));
      const windowId = await eventually(async () => (await execute("xdotool", ["search", "--onlyvisible", "--name", "Save private Claude session"], {timeout: 2000})).stdout.trim().split("\n")[0], {within: 15_000, until: value => Boolean(value)});
      const cancel = () => evaluateOnSurface(app, browserScript(transfer => window.__OMNIRUSH_ELECTRON__.invokeDesktop("__cancelTransfer", transfer), [transferId]));
      const active = await cancel();
      await execute("xdotool", ["windowfocus", "--sync", windowId]);
      await execute("xdotool", ["key", "--clearmodifiers", "Escape"]);
      return {active, outcome: await pending, stillActive: await cancel()};
    },
    async runtimeWitness() {
      return evaluateOnSurface(app, async () => {
        const bridge = window.__OMNIRUSH_ELECTRON__;
        const info = await bridge.invokeDesktop("omnirushServerInfo");
        // Normal desktop bootstrap stores its own embedded server URL here.
        return {protocol: location.protocol, bridge: typeof bridge.invokeDesktop === "function", embeddedServerSelected: localStorage.getItem("omnirush.server.urlOverride") === info.baseUrl};
      });
    },
    prepareDownload() {
      if (!packaged) return;
      if (process.platform !== "linux") throw new Error("The packaged native save-dialog driver currently requires Linux/xdotool");
      dialogTask = (async () => {
        const windowId = await eventually(async () => (await execute("xdotool", ["search", "--onlyvisible", "--name", "Save private Claude session"], {timeout: 2000})).stdout.trim().split("\n")[0], {within: 180_000, until: value => Boolean(value)});
        await execute("xdotool", ["windowfocus", "--sync", windowId]);
        await execute("xdotool", ["key", "--clearmodifiers", "ctrl+l"]);
        await execute("xdotool", ["key", "--clearmodifiers", "ctrl+a"]);
        await execute("xdotool", ["type", "--clearmodifiers", "--delay", "1", path.join(root, "desktop-download.zip")]);
        await execute("xdotool", ["key", "--clearmodifiers", "alt+s"]);
      })();
      void dialogTask.catch(() => undefined);
    },
    async downloaded() {
      await dialogTask;
      if (!packaged) return null;
      return eventually(async () => (await fs.stat(path.join(root, "desktop-download.zip"))).size, {within: 30_000, until: bytes => bytes > 0});
    },
    async layout() {
      return evaluateOnSurface(app, () => {
        const conversation = document.querySelector('[aria-label="Claude conversation"]');
        const composer = document.querySelector('textarea[aria-label="Message Claude"]');
        if (!conversation || !composer || !conversation.lastElementChild) throw new Error("Conversation layout unavailable");
        return {composerTop: composer.getBoundingClientRect().top, conversationBottom: conversation.getBoundingClientRect().bottom, lastMessageBottom: conversation.lastElementChild.getBoundingClientRect().bottom};
      });
    },
    async desktopExport(id: string) {
      return downloadClaudeArchive({url: `${ready.baseUrl}/workspace/${ready.workspaceId}/claude/sessions/${id}/export`, headers: {authorization: `Bearer ${ready.token}`}}, {
        localServerUrl: ready.baseUrl, allowedUrlPrefixes: [], stagingDir: path.join(root, "desktop-transfers"), fetcher: fetch,
        chooseDestination: async (filename: string) => path.join(root, filename),
      });
    },
    async session() { return (await request("sessions")).body[0]; },
    async witness() { return (await fetch(`${ready.gateway}/witness`)).json(); },
    async access(enabled: boolean) { await fetch(`${ready.gateway}/control`, {method: "POST", body: JSON.stringify({access: enabled})}); },
    async control(body: Record<string, unknown>) { await fetch(`${ready.gateway}/control`, {method: "POST", body: JSON.stringify(body)}); },
    async switchToEmptyWorkspace() {
      if (!packaged) throw new Error("The workspace navigation witness requires the packaged desktop");
      const folderPath = path.join(root, "other-project"); await fs.mkdir(folderPath);
      await evaluateOnSurface(app, browserScript(async folder => {
        const bridge = window.__OMNIRUSH_ELECTRON__;
        const info = await bridge.invokeDesktop("omnirushServerInfo");
        const response = await fetch(`${info.baseUrl}/workspaces/local`, {method: "POST", headers: {authorization: `Bearer ${info.ownerToken}`, "content-type": "application/json"}, body: JSON.stringify({folderPath: folder, name: "Other Claude project", preset: "starter"})});
        if (!response.ok) throw new Error(`Second workspace registration failed: ${response.status}`);
        const state = await response.json();
        const workspace = state.workspaces.find((entry: {path: string; id: string}) => entry.path === folder);
        if (!workspace) throw new Error("Second workspace was not created");
        await bridge.invokeDesktop("workspaceSetSelected", workspace.id);
        await bridge.invokeDesktop("workspaceSetRuntimeActive", workspace.id);
        location.hash = `/workspace/${workspace.id}/claude`;
      }, [folderPath]));
    },
    async exportReceipt(id: string) {
      const response = await fetch(`${ready.baseUrl}/workspace/${ready.workspaceId}/claude/sessions/${id}/export`, {method: "POST", headers: {authorization: `Bearer ${ready.token}`}});
      let bytes = 0;
      const reader = response.body?.getReader();
      if (reader) try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; } }
      finally { reader.releaseLock(); }
      return {status: response.status, bytes};
    },
    async mutateSession(id: string, mutation: "model" | "legacy") {
      for (const owner of await fs.readdir(path.join(root, "claude-sessions"))) {
        const file = path.join(root, "claude-sessions", owner, id, "session.json");
        const raw = await fs.readFile(file, "utf8").catch(() => null); if (!raw) continue;
        const state = JSON.parse(raw);
        if (mutation === "model") state.model = "claude-haiku-4-5-20251001";
        else delete state.contract;
        await fs.writeFile(file, JSON.stringify(state, null, 2));
        return async () => { await fs.writeFile(file, raw); };
      }
      throw new Error("Session metadata unavailable");
    },
    async nativeEvidence(id: string) {
      const owners = await fs.readdir(path.join(root, "claude-sessions"));
      for (const owner of owners) {
        const dir = path.join(root, "claude-sessions", owner, id);
        try {
          const manifest = JSON.parse(await fs.readFile(path.join(dir, "native", "manifest.json"), "utf8"));
          const state = JSON.parse(await fs.readFile(path.join(dir, "session.json"), "utf8"));
          const replay = JSON.parse(await fs.readFile(path.join(dir, "replay.json"), "utf8"));
          const readWitnesses = (await fs.readFile(path.join(dir, "transport", "hooks.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.witness?.sha256);
          const modelRequests = (await fs.readFile(path.join(dir, "policy", "model-requests.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
          const bundle = await fs.stat(path.join(dir, `${id}.zip`)).catch(() => null);
          return {manifest, state, replay, readWitnesses, modelRequests, zipBytes: bundle?.size ?? 0};
        } catch { /* owner directory not this session */ }
      }
      throw new Error("Complete session evidence unavailable");
    },
    async [Symbol.asyncDispose]() {
      await fs.writeFile(path.join(root, "fixture-witness.json"), JSON.stringify(await (await fetch(`${ready.gateway}/witness`)).json(), null, 2)).catch(() => {});
      await app[Symbol.asyncDispose](); lab.kill("SIGTERM");
      if (vite?.pid) try { process.kill(-vite.pid, "SIGTERM"); } catch { /* already stopped */ }
      await log.close(); await viteLog.close();
      // Evidence remains in the isolated root for debugging a failing journey.
    },
  };
}
