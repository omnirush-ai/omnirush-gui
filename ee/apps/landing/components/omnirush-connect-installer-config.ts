export const MCP_SERVER_URL = "https://api.omnirushlabs.com/mcp/agent";
export const CODEX_CONNECTIONS_DEEPLINK = "codex://settings/connections";
export const CHATGPT_SETTINGS_URL = "https://chatgpt.com/#settings/Connectors";
export type OmniRushConnectClientId =
  | "cursor"
  | "codex"
  | "chatgpt-desktop"
  | "claude-code"
  | "opencode"
  | "vs-code"
  | "any-client";
export type OmniRushConnectSupportStatus = "Verified" | "Setup only";
export type OmniRushConnectClientSupport = {
  status: OmniRushConnectSupportStatus;
  explanation: string;
};

export const CURSOR_SNIPPET = `${MCP_SERVER_URL}`;

export const CLAUDE_CODE_COMMAND = `claude mcp add --transport http omnirush ${MCP_SERVER_URL}`;
export const CODEX_COMMAND = `codex mcp add omnirush --url ${MCP_SERVER_URL}`;
export const CODEX_LOGIN_COMMAND = `codex mcp login omnirush`;
export const CODEX_RECONNECT_COMMAND = `codex mcp logout omnirush
codex mcp login omnirush`;

export const OPENCODE_SNIPPET = `{
  "mcp": {
    "omnirush": {
      "type": "remote",
      "enabled": true,
      "url": "${MCP_SERVER_URL}",
      "oauth": {}
    }
  }
}`;

export const VS_CODE_COMMAND = `code --add-mcp '{"name":"omnirush","type":"http","url":"${MCP_SERVER_URL}"}'`;
export const ANY_CLIENT_COMMAND = `${MCP_SERVER_URL}`;
export const OPENCODE_AUTH_COMMAND = `opencode mcp auth omnirush`;
export const OPENCODE_RECONNECT_COMMAND = `opencode mcp logout omnirush
opencode mcp auth omnirush`;

export const CONNECT_CLIENT_SUPPORT: Record<OmniRushConnectClientId, OmniRushConnectClientSupport> = {
  "cursor": {
    status: "Setup only",
    explanation: "Setup guide only: paste the server URL into Cursor and start OAuth. Cursor Desktop's cursor://anysphere.cursor-mcp/oauth/callback callback is accepted through an exact allowlist with PKCE S256 enforced. Native proof is not complete."
  },
  "codex": {
    status: "Setup only",
    explanation: "Setup guide only: add OmniRush.ai, run codex mcp login omnirush, and reconnect with logout then login. Native proof must be rerun on this exact branch."
  },
  "chatgpt-desktop": {
    status: "Setup only",
    explanation: "Setup guide only: paste the URL in ChatGPT Settings > MCP servers and start OAuth there. Native proof is not complete."
  },
  "claude-code": {
    status: "Setup only",
    explanation: "Setup guide only: add the server, then use /mcp in Claude Code to run the client auth flow. Native proof is not complete."
  },
  "opencode": {
    status: "Verified",
    explanation: "Verified with OpenCode native remote MCP OAuth flow."
  },
  "vs-code": {
    status: "Setup only",
    explanation: "Setup guide only: add the server with the VS Code CLI, then start OAuth from VS Code's MCP server prompt. Native proof is not complete."
  },
  "any-client": {
    status: "Setup only",
    explanation: "Setup guide only: use clients that support remote Streamable HTTP MCP servers and OAuth. Native proof depends on the client."
  }
};

export const CONNECT_CLIENTS: OmniRushConnectClientId[] = [
  "cursor",
  "codex",
  "chatgpt-desktop",
  "claude-code",
  "opencode",
  "vs-code",
  "any-client"
];
