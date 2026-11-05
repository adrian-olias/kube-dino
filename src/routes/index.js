// Path → HTTP method → controller.
export function createRoutes({ health, cluster, games }) {
  return {
    "/healthz": { GET: health.check },
    "/api/cluster": { GET: cluster.get },
    "/api/games": { GET: games.stats, POST: games.start },
    "/api/games/:id/heartbeat": { POST: games.heartbeat },
    "/api/games/:id/finish": { POST: games.finish },
  };
}
