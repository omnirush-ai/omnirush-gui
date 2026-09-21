export const OMNIRUSH_WEB_ACCESS_REQUIRED_CODE = "omnirush_web_access_required" as const
export const OMNIRUSH_WEB_ACCESS_REQUIRED_MESSAGE =
  "An active OmniRush.ai Web subscription or complimentary access is required to use OmniRush.ai Cloud."

export class OmniRushWebAccessRequiredError extends Error {
  readonly code = OMNIRUSH_WEB_ACCESS_REQUIRED_CODE

  constructor() {
    super(OMNIRUSH_WEB_ACCESS_REQUIRED_MESSAGE)
    this.name = "OmniRushWebAccessRequiredError"
  }
}

export function omniRushWebAccessRequiredPayload() {
  return {
    error: OMNIRUSH_WEB_ACCESS_REQUIRED_CODE,
    message: OMNIRUSH_WEB_ACCESS_REQUIRED_MESSAGE,
  }
}
