// /api/games: the totals for the panel, and the life of one game.
//   GET  /api/games                → { playing, played, best }, or 503 without a store
//   POST /api/games                → 201 { id, heartbeatSeconds }
//   POST /api/games/:id/heartbeat  → 200, or 404 when the game expired
//   POST /api/games/:id/finish     → 200 with the totals (also for a retry), 404, 422 or 503
import { HEARTBEAT_SECONDS } from "../services/games.service.js";
import { HttpError, readJson } from "../utils/http.js";

const FINISH_ERRORS = {
  unknown: [404, "unknown game"],
  rejected: [422, "implausible score"],
  unavailable: [503, "game store unavailable"],
};

export function createGamesController({ gamesService }) {
  function totals() {
    const stats = gamesService.stats();
    if (!stats) throw new HttpError(503, "game store unavailable");
    return { status: 200, body: stats };
  }

  return {
    stats: async () => totals(),

    start: async () => {
      const id = gamesService.start();
      if (!id) throw new HttpError(503, "not counting games right now");
      return { status: 201, body: { id, heartbeatSeconds: HEARTBEAT_SECONDS } };
    },

    heartbeat: async (req, { id }) => {
      if (!gamesService.heartbeat(id)) throw new HttpError(404, "unknown game");
      return { status: 200, body: { ok: true } };
    },

    finish: async (req, { id }) => {
      const { score } = (await readJson(req)) ?? {};
      const result = await gamesService.finish(id, score);
      if (FINISH_ERRORS[result]) throw new HttpError(...FINISH_ERRORS[result]);
      return totals();
    },
  };
}
