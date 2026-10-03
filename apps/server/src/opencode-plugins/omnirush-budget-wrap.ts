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
}) => {
  const baseUrl = (process.env.OMNIRUSH_ENGINE_ADAPTER_URL?.trim() ?? "").replace(/\/+$/, "");
  const authorization = process.env.OMNIRUSH_ENGINE_ADAPTER_AUTHORIZATION?.trim() ?? "";
  const fetcher = input.fetch ?? globalThis.fetch;

  async function compact(sessionID: string): Promise<void> {
    const entry = pending.get(sessionID);
    if (!entry || entry.inFlight || !baseUrl) return;
    entry.inFlight = true;
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
      pending.delete(sessionID);
    } catch {
      // Leave the pending marker so the next idle event can retry. This path
      // never inserts a prompt or diagnostic message into the user's trace.
      entry.inFlight = false;
    }
  }

  return {
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
