/** `target` relative to the folder of `from` (both project paths), or null when it leaves the project. */
export function resolveProjectPath(from: string, target: string): string | null {
  const clean = target.split(/[?#]/)[0]!;
  if (!clean) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    return null;
  }
  const parts = decoded.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/** Finds a rendered Markdown heading by its explicit id or GitHub-style slug. */
export function findMarkdownAnchor(root: HTMLElement, anchor: string): HTMLElement | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(anchor);
  } catch {
    return null;
  }

  return Array.from(root.querySelectorAll<HTMLElement>("[id]")).find((element) => element.id === decoded)
    ?? Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")).find(
      (element) => slugMarkdownHeading(element.textContent ?? "") === decoded,
    )
    ?? null;
}

/** GitHub-style heading anchor. */
function slugMarkdownHeading(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
}
