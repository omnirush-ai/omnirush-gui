export type GoalInvocation =
  | { action: "status" | "pause" | "resume" | "clear" | "edit" }
  | { action: "set"; objective: string };

/** Control words apply only when they are the whole argument. */
export function parseGoalInvocation(text: string): GoalInvocation | null {
  const match = text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const objective = (match[1] ?? "").trim();
  const control = objective.toLowerCase();
  if (!control) return { action: "status" };
  if (control === "pause" || control === "resume" || control === "clear" || control === "edit") {
    return { action: control };
  }
  return { action: "set", objective };
}

export function goalStatusLabel(status: "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete") {
  switch (status) {
    case "active": return "Active";
    case "paused": return "Paused";
    case "blocked": return "Needs help";
    case "usage_limited": return "Usage limit reached";
    case "budget_limited": return "Token limit reached";
    case "complete": return "Complete";
  }
}

export function formatGoalTime(seconds: number) {
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
