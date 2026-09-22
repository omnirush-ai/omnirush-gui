export const OMNIRUSH_FEEDBACK_URL = "https://github.com/omnirush-ai/omnirush-gui/issues/new";

export function buildDenFeedbackUrl(options?: {
  pathname?: string;
  orgSlug?: string | null;
  topic?: string;
}) {
  const params = new URLSearchParams({
    source: "omnirush-web-app",
    deployment: "web",
    entrypoint: options?.pathname ?? "dashboard"
  });

  if (options?.orgSlug) {
    params.set("org", options.orgSlug);
  }

  if (options?.topic) {
    params.set("topic", options.topic);
  }

  return `${OMNIRUSH_FEEDBACK_URL}?${params.toString()}`;
}
