const UNAVAILABLE_COPY = "this model is temporarily unavailable. Try again in a minute, or pick another model."
const BUSY_COPY = "this model is busy right now. Try again in a moment."
const STALLED_COPY = "the model stopped responding before it finished. Retry the request, or pick a lower effort."
const SETUP_COPY = "the model route is being set up. Try again later."
const BOUND_MODEL_COPY = "this chat keeps the model it started on. Start a new chat to use another model."

/**
 * What the user reads for an omnirush.ai gateway error: the backend's own
 * codes, and the relay codes it passes through (mid-stream as
 * `upstream_<code>`). One table for the local server's broker and the app
 * (engine v2 shows the bare code). Kept in step with the console's chat copy.
 */
export const GATEWAY_ERROR_COPY: Readonly<Record<string, string>> = {
  model_unavailable: "this model is not available on your account right now. Pick another model.",
  model_not_allowed: "this model is not available to your account. Pick another model.",
  model_not_found: "this model is not available right now. Pick another model.",
  model_input_not_supported: "this model cannot read that attachment. Remove the image or PDF, or pick another model.",
  model_concurrency_limited: "too many answers are already running on this model. Wait for one to finish, then try again.",
  model_request_too_large: "this request is too large to send. Remove an attachment or start a new session.",
  reasoning_effort_not_allowed: "this model does not offer the selected effort. Pick another effort.",
  unsupported_model_endpoint: "this model cannot run this kind of request. Pick another model.",
  daily_grant_exhausted: "you have used today's model allowance. It refills at 00:00 UTC.",
  grant_check_unavailable: "your model allowance could not be checked. Try again in a moment.",
  account_inactive: "model access is paused for this account. Open your omnirush.ai dashboard to see why.",
  consent_required: "accept the omnirush.ai data terms on your dashboard, then try again.",
  consent_version_outdated: "the omnirush.ai data terms were updated. Accept the new version on your dashboard, then try again.",
  internal_proxy_unavailable: "the model service did not respond. Try again in a moment.",
  internal_proxy_not_configured: SETUP_COPY,
  internal_proxy_ca_missing: SETUP_COPY,
  muse_relay_not_configured: UNAVAILABLE_COPY,
  model_upstream_auth_failed: UNAVAILABLE_COPY,
  model_upstream_misconfigured: UNAVAILABLE_COPY,
  model_upstream_unavailable: "the model service could not be reached. Try again in a moment.",
  stream_interrupted: "the model stream ended before the response completed. Retry the request.",
  idle_timeout: STALLED_COPY,
  first_byte_timeout: STALLED_COPY,
  request_timeout: STALLED_COPY,
  provider_error: "the model provider could not complete this request.",
  provider_unavailable: UNAVAILABLE_COPY,
  provider_auth_error: UNAVAILABLE_COPY,
  capacity_unavailable: UNAVAILABLE_COPY,
  circuit_open: UNAVAILABLE_COPY,
  maintenance: UNAVAILABLE_COPY,
  draining: UNAVAILABLE_COPY,
  auth_unavailable: UNAVAILABLE_COPY,
  token_capacity: BUSY_COPY,
  gateway_overload: BUSY_COPY,
  queue_timeout: BUSY_COPY,
  omni_queue_timeout: "every model seat is taken right now, and this turn waited in line too long. Send your message again; your place in line is kept for a few minutes.",
  provider_rate_limited: BUSY_COPY,
  // The proxy router had no usable upstream channel for the model (all capped, cooling down or paused).
  no_channel_available: BUSY_COPY,
  voice_unavailable: "voice input is not available on this account yet.",
  transcription_unavailable: "the transcription service did not answer. Try again in a moment.",
  audio_unreadable: "the recording could not be read. Try again.",
  update_required: "this version of OmniRush.ai is no longer supported. Update the app to keep using models; your sessions are kept.",
  // A model outside the project's mode (model-modes/): the gateway's refusal, or the broker's own before sending.
  model_not_in_mode: "this model isn't available in this project. Pick another model and send again.",
  session_model_fixed: BOUND_MODEL_COPY,
  // Strict sessions (model-modes/strict-sessions.mjs): the gateway holds a bound chat to its model and mode.
  model_not_bound: BOUND_MODEL_COPY,
  mode_not_bound: "this chat keeps the project mode it started in. Start a new chat to change it.",
  session_model_used: "this chat already ran on another model. Start a new chat to use this one.",
}

/** The copy for a gateway error code (bare or `upstream_<code>`), or null for a code without copy. */
export function gatewayErrorMessage(code: string, detail?: string | null): string | null {
  const copy = GATEWAY_ERROR_COPY[code] ?? GATEWAY_ERROR_COPY[code.replace(/^upstream_/, "")]
  if (!copy) return null
  // A provider error names what it refused ("Upstream returned an error: <why>").
  const why = code.endsWith("provider_error")
    ? detail?.replace(/^\s*upstream returned an error:?/i, "").trim().slice(0, 300)
    : ""
  return why ? `omnirush.ai: ${copy} (${why})` : `omnirush.ai: ${copy}`
}

/** A gateway code without copy: a plain line that still names the code for support. */
export function unknownGatewayErrorMessage(code: string): string {
  return `omnirush.ai could not complete the model request (${code}).`
}
