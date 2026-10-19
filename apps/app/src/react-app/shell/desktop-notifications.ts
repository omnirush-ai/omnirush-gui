import { desktopNotificationShow } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/utils";
import {
  DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE,
  DEFAULT_NOTIFICATION_SOUNDS_ENABLED,
  isDesktopNotificationPreference,
  type DesktopNotificationPreference,
} from "@/react-app/kernel/desktop-notification-preferences";
import { LOCAL_PREFERENCES_KEY } from "@/react-app/kernel/local-preferences-storage";
import { playNotificationSound } from "./notification-sounds";

type DesktopNotificationImportance = "important" | "routine";
type WebNotificationHandler = (title: string, description?: string, href?: string) => Promise<void>;

export type DesktopNotificationEvent =
  | { type: "task.completed"; sessionId: string }
  | { type: "task.failed"; sessionId: string; errorText?: string }
  | { type: "permission.asked"; sessionId: string; detail?: string }
  | { type: "question.asked"; sessionId: string; question?: string };

type NotificationCopy = {
  title: string;
  body: string;
  importance: DesktopNotificationImportance;
};

let webNotificationHandler: WebNotificationHandler | null = null;

export function setWebNotificationHandler(handler: WebNotificationHandler | null): void {
  webNotificationHandler = handler;
}

function readNotificationPreferences() {
  const defaults = { mode: DEFAULT_DESKTOP_NOTIFICATION_PREFERENCE, sounds: DEFAULT_NOTIFICATION_SOUNDS_ENABLED };
  if (typeof window === "undefined") return defaults;
  try {
    const raw = window.localStorage.getItem(LOCAL_PREFERENCES_KEY);
    if (!raw) return defaults;
    const parsed: unknown = JSON.parse(raw);
    const value = parsed && typeof parsed === "object"
      ? Reflect.get(parsed, "desktopNotifications")
      : undefined;
    const sounds = parsed && typeof parsed === "object" ? Reflect.get(parsed, "notificationSounds") : undefined;
    return {
      mode: isDesktopNotificationPreference(value) ? value : defaults.mode,
      sounds: typeof sounds === "boolean" ? sounds : defaults.sounds,
    };
  } catch {
    return defaults;
  }
}

function shouldNotify(
  preference: DesktopNotificationPreference,
  importance: DesktopNotificationImportance,
) {
  if (preference === "off") return false;
  if (preference === "important") return importance === "important";
  return true;
}

function isAppInView() {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

function copyForEvent(event: DesktopNotificationEvent): NotificationCopy {
  switch (event.type) {
    case "task.completed":
      return {
        title: "Task completed",
        body: "The session finished running.",
        importance: "routine",
      };
    case "task.failed":
      return {
        title: "Task failed",
        body: event.errorText?.trim() || "The session stopped with an error.",
        importance: "important",
      };
    case "permission.asked":
      return {
        title: "Permission needed",
        body: event.detail?.trim() || "A session is waiting for permission before it can continue.",
        importance: "important",
      };
    case "question.asked":
      return {
        title: "Question needs your answer",
        body: event.question?.trim() || "A session is waiting for your answer.",
        importance: "important",
      };
  }
}

export function notifyDesktopEvent(event: DesktopNotificationEvent): void {
  const copy = copyForEvent(event);
  if (isAppInView()) return;
  const preferences = readNotificationPreferences();
  if (preferences.sounds) {
    playNotificationSound(event.type === "task.completed" ? "completed" : "attention");
  }
  if (!shouldNotify(preferences.mode, copy.importance)) return;

  if (!isDesktopRuntime()) {
    void webNotificationHandler?.(copy.title, copy.body).catch(() => undefined);
    return;
  }

  void desktopNotificationShow({
    title: copy.title,
    body: copy.body,
    silent: true,
  }).catch(() => undefined);
}
