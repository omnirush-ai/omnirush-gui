/** Automatically finish an account-level quota wrap in the desktop GUI.
 *
 * The backend decides when a grant needs wrapping and publishes a private
 * response header. This plugin waits until the engine reports the session
 * idle, then asks the local engine to compact. The compaction record itself
 * contains the generated handoff summary; no warning or synthetic prompt is
 * written to the session trace.
 */
const REQUIRED_HEADER = "x-omnirush-wrap-required";
const WRAP_UP_HEADER = "x-omnirush-wrap-up";
const pending = new Map<string, { inFlight: boolean }>();
type BudgetFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type BudgetClient = {
  tui?: { showToast?: (input: { query?: { directory?: string }; body: { title: string; message: string; variant: string; duration: number } }) => Promise<unknown> };
};

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionIDFromEvent(event: unknown): string {
  if (!record(event) || !record(event.properties)) return "";
  const properties = event.properties;
  return typeof properties.sessionID === "string" ? properties.sessionID : "";
}

export const OmniRushBudgetWrap = async (input: {
  directory?: string;
  fetch?: BudgetFetch;
  client?: BudgetClient;
}) => {
  const baseUrl = (process.env.OMNIRUSH_ENGINE_ADAPTER_URL?.trim() ?? "").replace(/\/+$/, "");
  const authorization = process.env.OMNIRUSH_ENGINE_ADAPTER_AUTHORIZATION?.trim() ?? "";
  const fetcher = input.fetch ?? globalThis.fetch;

  async function notify(title: string, message: string, variant: "info" | "warning"): Promise<void> {
    const body = { title, message, variant, duration: 12_000 };
    try {
      await input.client?.tui?.showToast?.({
        ...(input.directory ? { query: { directory: input.directory } } : {}),
        body,
      });
    } catch {
      // The headless adapter may not implement the native TUI endpoint.
    }
    // The desktop shell has its own notification center. The server-scoped
    // control request is consumed by the connected window and never becomes a
    // session message or trace part.
    const server = (process.env.OMNIRUSH_SERVER_URL ?? "").trim().replace(/\/+$/, "");
    const token = (process.env.OMNIRUSH_SERVER_TOKEN ?? process.env.OMNIRUSH_POLICY_TOKEN ?? "").trim();
    if (!server || !token) return;
    await fetcher(server + "/experimental/ui-control/request", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        kind: "command",
        input: { id: "notifications.show", args: { title, body: message, severity: variant } },
      }),
    }).catch(() => undefined);
  }

  async function compact(sessionID: string): Promise<void> {
    const entry = pending.get(sessionID);
    if (!entry || entry.inFlight || !baseUrl) return;
    entry.inFlight = true;
    await notify("Wrapping up", "Your token allowance is nearly exhausted. Saving a handoff now.", "warning");
    try {
      const response = await fetcher(
        baseUrl + "/session/" + encodeURIComponent(sessionID) + "/summarize",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization ? { authorization } : {}),
            ...(input.directory ? { "x-opencode-directory": encodeURIComponent(input.directory) } : {}),
          },
          body: "{}",
        },
      );
      if (!response.ok) throw new Error("automatic budget wrap returned " + response.status);
      await notify(
        "Wrap up complete",
        "This session was wrapped because your token allowance was nearly exhausted. Please continue after receiving more tokens.",
        "info",
      );
      pending.delete(sessionID);
    } catch {
      // Leave the pending marker so the next idle event can retry. This path
      // never inserts a prompt or diagnostic message into the user's trace.
      entry.inFlight = false;
    }
  }

  return {
    "chat.headers": async (input: { sessionID?: string; model?: { providerID?: string } }, output: { headers: Record<string, string> }) => {
      const sessionID = input?.sessionID?.trim() ?? "";
      if (sessionID && input.model?.providerID === "omnirush") output.headers["x-omnirush-session-id"] = sessionID;
    },
    "omnirush.http.response": async (event: { request?: Request; response?: Response }) => {
      const request = event?.request;
      const response = event?.response;
      const sessionID = request?.headers.get("x-omnirush-session-id")?.trim() ?? "";
      if (!sessionID || !response) return;
      if (response.headers.get(WRAP_UP_HEADER) === "1") {
        pending.delete(sessionID);
        return;
      }
      if (response.headers.get(REQUIRED_HEADER) === "1") {
        pending.set(sessionID, { inFlight: false });
      }
    },
    event: async ({ event }: { event: unknown }) => {
      if (!record(event) || event.type !== "session.idle") return;
      const sessionID = sessionIDFromEvent(event);
      if (sessionID) await compact(sessionID);
    },
    dispose: async () => {
      pending.clear();
    },
  };
};
