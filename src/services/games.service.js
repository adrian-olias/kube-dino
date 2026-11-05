// Game sessions: who is playing now, games played and the best score.
//
// Sessions (presence) live in memory and rebuild within seconds after a
// restart. Totals and the ids already counted live in the store, on disk.
// The rules are in the README, under "Games".
import { randomUUID } from "node:crypto";
import { StoreUnavailable } from "./store.service.js";

export const HEARTBEAT_SECONDS = 5; // how often the page reports a running game
const PRESENCE_SECONDS = 15; // no heartbeat for this long: the session is gone
const MAX_SESSION_SECONDS = 30 * 60;
const MAX_SESSIONS = 500;
// The game scores about 70 points a second at top speed, plus 25 a pod.
const MAX_POINTS_PER_SECOND = 100;
const SCORE_SLACK = 50; // network delay at both ends of the game
// Counted ids are kept for retries: 24 hours or the last 50,000, whichever is fewer.
const COUNTED_MS = 24 * 3600 * 1000;
const MAX_COUNTED = 50_000;

export function createGamesService({ now, store, maxCounted = MAX_COUNTED }) {
  const sessions = new Map(); // id → { startedAt, lastSeen }

  // The session if it is still alive; expired ones are dropped on the way.
  function live(id) {
    const session = sessions.get(id);
    if (!session) return null;
    const t = now();
    if (t - session.lastSeen > PRESENCE_SECONDS * 1000 || t - session.startedAt > MAX_SESSION_SECONDS * 1000) {
      sessions.delete(id);
      return null;
    }
    return session;
  }

  function sweep() {
    for (const id of sessions.keys()) live(id);
  }

  // Drops ids past the retry window, then the oldest past the cap.
  // Ids were added in order, so the first keys are the oldest.
  function prune(counted) {
    const ids = Object.keys(counted);
    let drop = Math.max(0, ids.length - maxCounted);
    while (drop < ids.length && now() - counted[ids[drop]] > COUNTED_MS) drop++;
    for (const id of ids.slice(0, drop)) delete counted[id];
  }

  return {
    get available() {
      return store.available;
    },

    // A new session id, or null when there are too many open or no store.
    start() {
      sweep();
      if (!store.available || sessions.size >= MAX_SESSIONS) return null;
      const id = randomUUID();
      sessions.set(id, { startedAt: now(), lastSeen: now() });
      return id;
    },

    // false when the session is unknown or expired.
    heartbeat(id) {
      const session = live(id);
      if (session) session.lastSeen = now();
      return Boolean(session);
    },

    // One of:
    //   "counted"     saved now
    //   "duplicate"   saved before; a retry, maybe after a restart
    //   "rejected"    implausible score, not counted
    //   "unknown"     no such live session
    //   "unavailable" not saved, the store failed; the session stays open for a retry
    async finish(id, score) {
      if (store.state?.counted[id] !== undefined) {
        sessions.delete(id);
        return "duplicate";
      }
      const session = live(id);
      if (!session) return "unknown";

      const seconds = (now() - session.startedAt) / 1000;
      if (!Number.isInteger(score) || score < 0 || score > seconds * MAX_POINTS_PER_SECOND + SCORE_SLACK) {
        sessions.delete(id);
        return "rejected";
      }

      let saved;
      try {
        saved = await store.update((state) => {
          // Counted while this one waited in the queue.
          if (state.counted[id] !== undefined) return null;
          state.played += 1;
          state.best = Math.max(state.best, score);
          state.counted[id] = now();
          prune(state.counted);
          return state;
        });
      } catch (err) {
        if (err instanceof StoreUnavailable) return "unavailable";
        throw err;
      }
      sessions.delete(id);
      return saved ? "counted" : "duplicate";
    },

    // null when the store is unavailable: its totals can't be trusted.
    stats() {
      sweep();
      if (!store.available) return null;
      return { playing: sessions.size, played: store.state.played, best: store.state.best };
    },
  };
}
