// Embedded so the compiled desktop server and the CLI ship exactly the same runner.
export const SDK_VERSION = "0.3.306";
export const CLAUDE_VERSION = "2.1.306";
export const IMAGE = `omnirush-claude-sdk:${SDK_VERSION}-3`;
export const MODEL = "claude-opus-5-5";
export const CAPTURE_POLICY_VERSION = "claude-native-2";
// This is also passed as SDK managed policy. The on-disk copy is root-owned
// so a project setting or tool cannot widen it for a nested Claude process.
export const MANAGED_SETTINGS = JSON.stringify({availableModels: [MODEL], availableModelsMatch: "exact", enforceAvailableModels: true, deniedModels: ["sonnet", "haiku"], allowManagedHooksOnly: true});
export const DOCKERFILE = `FROM node:22.21.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep python3 python3-venv ca-certificates zip unzip procps && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate
WORKDIR /opt/claude
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY controller.mjs ./
COPY managed-settings.json /etc/claude-code/managed-settings.json
RUN mkdir -p /workspace /home/node/.claude /home/node/evidence && chown -R node:node /workspace /home/node
ENV HOME=/home/node CLAUDE_CONFIG_DIR=/home/node/.claude
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
`;

export const CONTROLLER = String.raw`
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
const input = [];
for await (const chunk of process.stdin) input.push(chunk);
const request = JSON.parse(Buffer.concat(input).toString('utf8'));
const append = (file, value) => {
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
};
const evidence = '/home/node/evidence';
fs.mkdirSync(evidence, {recursive: true, mode: 0o700});
const hooks = {};
for (const event of ['PreToolUse','PostToolUse','PostToolUseFailure','SubagentStart','SubagentStop','PreCompact','PostCompact','SessionStart','SessionEnd','Stop','StopFailure']) {
  hooks[event] = [{hooks: [async (input, toolUseId) => {
    let witness;
    if (event === 'PreToolUse' && input.tool_name === 'Read' && typeof input.tool_input?.file_path === 'string') {
      const file = input.tool_input.file_path;
      try {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        try {
          const stat = fs.fstatSync(fd);
          if (stat.isFile() && stat.size <= 512 * 1024 * 1024) {
            const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
            for (;;) { const count = fs.readSync(fd, buffer); if (!count) break; hash.update(buffer.subarray(0, count)); }
            const after = fs.fstatSync(fd);
            if (after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs) witness = {path: file, bytes: stat.size, sha256: hash.digest('hex'), mode: stat.mode};
          }
        } finally { fs.closeSync(fd); }
      } catch { /* Missing/unreadable files retain their actual failed tool result. */ }
    }
    append(evidence + '/hooks.jsonl', {time: new Date().toISOString(), turn: request.turn, input, toolUseId, witness});
    return {};
  }]}];
}
const env = {
  PATH: process.env.PATH, HOME: '/home/node', LANG: 'C.UTF-8',
  CLAUDE_CONFIG_DIR: '/home/node/.claude',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_SHELL: '/bin/bash',
  ANTHROPIC_MODEL: request.model, ANTHROPIC_DEFAULT_MODEL: request.model,
  ANTHROPIC_DEFAULT_OPUS_MODEL: request.model,
  ANTHROPIC_DEFAULT_SONNET_MODEL: request.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: request.model,
  ANTHROPIC_DEFAULT_FABLE_MODEL: request.model, ANTHROPIC_SMALL_FAST_MODEL: request.model,
  CLAUDE_CODE_SUBAGENT_MODEL: request.model, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1',
  CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: request.model,
  CLAUDE_CODE_AUTO_MODE_MODEL: request.model, CLAUDE_CODE_BG_CLASSIFIER_MODEL: request.model,
  CLAUDE_CODE_NO_MODEL_FALLBACK: '1', CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
  ANTHROPIC_BASE_URL: request.baseUrl, ANTHROPIC_AUTH_TOKEN: request.token,
};
let success = false;
try {
  for await (const message of query({prompt: request.prompt, options: {
    cwd: '/workspace', env, model: request.model,
    ...(request.resume ? {resume: request.sessionId} : {sessionId: request.sessionId}),
    persistSession: true, includePartialMessages: true, forwardSubagentText: true,
    includeHookEvents: true, settingSources: [],
    managedSettings: {availableModels: [request.model], availableModelsMatch: 'exact', enforceAvailableModels: true, deniedModels: ['sonnet', 'haiku'], allowManagedHooksOnly: true},
    settings: {model: request.model, fallbackModel: []},
    systemPrompt: {type: 'preset', preset: 'claude_code'},
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    thinking: {type: 'adaptive'}, effort: 'high',
    maxTurns: 100, hooks,
    stderr: text => append(evidence + '/stderr.jsonl', {turn: request.turn, text}),
  }})) {
    append(evidence + '/sdk.jsonl', message);
    // A disk acknowledgement precedes every event delivered to the host.
    process.stdout.write(JSON.stringify(message) + '\n');
    if (message.type === 'result') success = message.subtype === 'success' && !message.is_error;
  }
} catch (error) {
  append(evidence + '/stderr.jsonl', {turn: request.turn, text: String(error)});
}
process.exitCode = success ? 0 : 1;
`;
