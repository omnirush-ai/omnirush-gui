// Ordering for the computer-use host (computer-use.mjs), kept apart so it can be tested without Electron.
//
// - Starts: a start takes the generation when it begins; turning computer use off (or stopping the host) moves
//   the generation on, so a start still in flight finds itself stale before it publishes anything (host, listener,
//   host.json) and closes what it made.
// - State answers: each read of the local server's state takes a number when it is sent; an answer older than one
//   already applied is dropped, so a slow or out-of-order answer can never bring back access a newer one took away.
export function createHostGate() {
  let generation = 0;
  let asked = 0;
  let applied = 0;
  return {
    /** The generation a start belongs to (take it before the first await). */
    begin: () => generation,
    /** Whether a start of `taken` may still publish. */
    current: (taken) => taken === generation,
    /** Off or stop: every start in flight is stale from now on. */
    revoke: () => { generation += 1; },
    /** A number for a state read, taken when it is sent. */
    ask: () => (asked += 1),
    /** Whether the answer to read `n` may be applied (and marks it applied). */
    fresh: (n) => {
      if (n < applied) return false;
      applied = n;
      return true;
    },
  };
}
