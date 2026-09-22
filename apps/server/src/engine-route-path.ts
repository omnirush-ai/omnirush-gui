/**
 * The engine's router (Hono) decodes a request path before matching it: every
 * unreserved percent-escape is decoded (`/session/x/prompt%5Fasync` routes as
 * `/session/x/prompt_async`), reserved escapes such as `%2F` stay encoded and
 * so never split a segment, a literal `%25` survives as `%25` for the param
 * decoder, and a malformed sequence is left in place. A path classifier that
 * looks at the raw proxy path therefore disagrees with the engine, which is
 * exactly how an encoded dispatch path could skip the sign-in gate and the
 * collector. Every classifier compares against this decoded form instead; the
 * request itself is still forwarded verbatim, the engine decodes it itself.
 */

function tryDecode(value: string, decoder: (input: string) => string): string {
  try {
    return decoder(value);
  } catch {
    return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (sequence) => {
      try {
        return decoder(sequence);
      } catch {
        return sequence;
      }
    });
  }
}

/** The path as the engine's router matches it (see the module comment). */
export function decodeEngineRoutePath(path: string): string {
  if (!path.includes("%")) return path;
  return tryDecode(path.includes("%25") ? path.replace(/%25/g, "%2525") : path, decodeURI);
}

/**
 * One segment of a decoded route path as the engine reads a path parameter
 * from it. Returns null when the segment is malformed and the engine would
 * not see the identifier the client meant.
 */
export function decodeEngineRouteParam(segment: string): string | null {
  if (!segment.includes("%")) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
