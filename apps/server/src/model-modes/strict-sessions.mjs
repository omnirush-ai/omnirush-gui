// Strict sessions: each chat binds its model and project mode with the server.
//
// GET /collect/capabilities `strict_sessions: {mode, bind, path, header}`: while
// `bind` is true, a chat's first request (where the client pins its model)
// is preceded by POST <path> {session_id, parent_session_id?, model, mode,
// revision?, capture_policy?}. A sub-agent names its root chat; a root the
// server does not know yet is bound first and the child sent once more. A
// conflict (the chat is bound to another model or mode, or already ran on
// another model unbound) or a verification refusal stops the request here.
// A Claude chat or a refused model goes on unbound. A bind that got no answer
// (a network failure, a 5xx, a timeout) depends on the switch: under
// `observe` the request goes on unbound and the bind is tried again on the
// next request; under `enforce` (or the last known `enforce` while the server
// cannot be asked) the request gets a retryable local error and nothing is
// sent, and so does a first prompt whose capture policy is not known yet.
// While binding is on, every model request of a chat (compactions, titles and
// sub-agents too) carries the server's `header` (X-OmniRush-Strict-Session):
// 1, so the gateway can bind it on the spot when the explicit bind failed.
// No `strict_sessions` (an older server): no bind, no header.
//
// The same file ships in omnirush-cli (src/model-modes/) and omnirush-gui
// (apps/server/src/model-modes/); PARITY.sha256 lists it in both. No imports.

export const STRICT_BIND_PATH = "/omnirush/device/session-binding";
export const SESSION_BINDING_CONFLICT = "session_binding_conflict";
export const SESSION_UNKNOWN_PARENT = "session_unknown_parent";
export const SESSION_MODEL_USED = "session_model_used";
export const STRICT_SESSION_HEADER = "x-omnirush-strict-session";
export const VERIFICATION_REQUIRED = "verification_required";
export const MODEL_NOT_BOUND = "model_not_bound";
export const MODE_NOT_BOUND = "mode_not_bound";
export const BIND_TIMEOUT_MS = 5_000;
export const VERIFICATION_MESSAGE = "Your account needs to be verified before it can use models. See https://omnirush.ai/console";
export const SESSION_BIND_UNCONFIRMED = "session_bind_unconfirmed";
export const UNCONFIRMED_MESSAGE = "Couldn't confirm this chat with the server. Try again.";
const MODES = new Set(["off", "observe", "enforce"]);

const PATH = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const HEADER = /^x-[a-z0-9-]{1,62}$/;

/**
 * A capabilities answer's strict sessions while the server asks clients to
 * bind: { mode, path, header } (header lower case; mode "observe" or
 * "enforce", an unknown one read as "enforce"), else null. Clients keep the
 * last one per server on disk: it stands while the server cannot be asked.
 */
export function strictSessions(capabilities) {
  const block = capabilities && typeof capabilities === "object" ? capabilities.strict_sessions : null;
  if (!block || typeof block !== "object" || block.bind !== true) return null;
  const header = typeof block.header === "string" ? block.header.trim().toLowerCase() : "";
  return {
    mode: MODES.has(block.mode) && block.mode !== "off" ? block.mode : "enforce",
    path: typeof block.path === "string" && PATH.test(block.path) ? block.path : STRICT_BIND_PATH,
    header: HEADER.test(header) ? header : STRICT_SESSION_HEADER,
  };
}

/** The plain refusal of a request on another model or mode than the chat's binding. */
export function bindingConflictMessage(binding, model) {
  const bound = binding && typeof binding === "object" ? binding : {};
  if (typeof bound.model === "string" && bound.model && bound.model !== model) return `This chat runs on ${bound.model}. Start a new chat to use ${model}.`;
  if (bound.mode === "box") return "This chat runs in the sandbox. Start a new chat to run outside it.";
  if (bound.mode === "native") return "This chat runs outside the sandbox. Start a new chat to run in it.";
  return "This chat runs on another model. Start a new chat to use this one.";
}

/** The plain refusal of a bind for a chat that already ran on other models (`models_used`). */
export function modelUsedMessage(modelsUsed, model) {
  const used = Array.isArray(modelsUsed) ? modelsUsed.filter((id) => typeof id === "string" && id && id !== model) : [];
  return used.length ? `This chat already ran on ${used.join(", ")}. Start a new chat to use ${model}.` : `This chat already ran on another model. Start a new chat to use ${model}.`;
}

function detailOf(answer) {
  const body = answer && answer.body;
  return body && typeof body === "object" && typeof body.detail === "string" ? body.detail : null;
}

/**
 * The binder of one client process. `post(path, body, signal)` sends the
 * bind (the client's bearer and origin) and resolves { status, body } (body
 * parsed JSON or null); it may throw. bind(chat) resolves { ok: true,
 * binding? } (binding: the server's stored binding of a 200, whose
 * capture_policy the chat then keeps) or { refused: { code, message, retry } },
 * where chat is { path, enforce?, sessionId, rootId?, model, mode, revision?,
 * capturePolicy?, root?: { model, mode, revision?, capturePolicy? } } (root:
 * the root chat's own pin, for binding it first). A session bound (or one the
 * server will not bind: a Claude chat, a refused model) is not asked again in
 * this process; the cache is keyed on the client's own id, never the echo.
 */
export function sessionBinder(post, { timeoutMs = BIND_TIMEOUT_MS } = {}) {
  const settled = new Set();
  const settle = (id) => {
    settled.add(id);
    while (settled.size > 4000) settled.delete(settled.values().next().value);
  };
  const send = async (path, body) => {
    try { return await post(path, body, AbortSignal.timeout(timeoutMs)); } catch { return null; }
  };
  const bodyOf = (id, parent, pin, capturePolicy) => ({
    session_id: id,
    ...(parent ? { parent_session_id: parent } : {}),
    model: pin.model,
    mode: pin.mode,
    ...(pin.revision ? { revision: pin.revision } : {}),
    ...(capturePolicy ? { capture_policy: capturePolicy } : {}),
  });
  return async function bind(chat) {
    if (!chat || !chat.path || !chat.sessionId || !chat.model || settled.has(chat.sessionId)) return { ok: true };
    const unconfirmed = { refused: { code: SESSION_BIND_UNCONFIRMED, message: UNCONFIRMED_MESSAGE, retry: true } };
    if (chat.enforce && !chat.capturePolicy) return unconfirmed;
    const parent = chat.rootId && chat.rootId !== chat.sessionId ? chat.rootId : null;
    const body = bodyOf(chat.sessionId, parent, chat, chat.capturePolicy);
    let answer = await send(chat.path, body);
    if (parent && answer && answer.status === 409 && detailOf(answer) === SESSION_UNKNOWN_PARENT) {
      const rootPin = chat.root && chat.root.model ? chat.root : chat;
      const root = await send(chat.path, bodyOf(parent, null, rootPin, rootPin.capturePolicy || chat.capturePolicy));
      if (root && root.status === 200) {
        settle(parent);
        answer = await send(chat.path, body);
      }
    }
    const status = answer ? answer.status : 0;
    const detail = detailOf(answer);
    if (detail === SESSION_BINDING_CONFLICT) {
      return { refused: { code: SESSION_BINDING_CONFLICT, message: bindingConflictMessage(answer.body.binding, chat.model), retry: false } };
    }
    if (detail === SESSION_MODEL_USED) {
      return { refused: { code: SESSION_MODEL_USED, message: modelUsedMessage(answer.body.models_used, chat.model), retry: false } };
    }
    if (detail === VERIFICATION_REQUIRED) {
      return { refused: { code: VERIFICATION_REQUIRED, message: VERIFICATION_MESSAGE, retry: false } };
    }
    // Bound (bound_late too), or a chat the server will not bind (a Claude chat, a refused model): settled.
    if (status === 200 || status === 400 || status === 422) {
      settle(chat.sessionId);
      const binding = status === 200 && answer.body && typeof answer.body.binding === "object" && answer.body.binding ? answer.body.binding : null;
      return binding ? { ok: true, binding } : { ok: true };
    }
    // No answer (network, 5xx, timeout, another status): enforce holds the request, observe lets it go.
    return chat.enforce ? unconfirmed : { ok: true };
  };
}
