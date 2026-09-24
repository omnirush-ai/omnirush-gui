import type { DenSettings, DenUser } from "./den-types";

export const denSessionUpdatedEvent = "omnirush-den-session-updated";
export const denSettingsChangedEvent = "omnirush-den-settings-changed";

export type DenSessionUpdatedDetail = {
  status?: "success" | "error" | "signed_out";
  baseUrl?: string | null;
  token?: string | null;
  user?: DenUser | null;
  email?: string | null;
  message?: string | null;
  /**
   * Set only when a person explicitly signed out or changed the control
   * plane. An automatic sign-out (token expiry, revoked session) leaves it
   * unset, so consumers must not force disruptive work such as restarting
   * the built-in server while runs are live.
   */
  userInitiated?: boolean;
};

export function dispatchDenSessionUpdated(detail: DenSessionUpdatedDetail) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<DenSessionUpdatedDetail>(denSessionUpdatedEvent, {
      detail,
    }),
  );
}

export type DenSettingsChangedDetail = {
  settings: DenSettings;
};

export function dispatchDenSettingsChanged(detail: DenSettingsChangedDetail) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<DenSettingsChangedDetail>(denSettingsChangedEvent, {
      detail,
    }),
  );
}
