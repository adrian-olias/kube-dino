// Path → HTTP method → controller.
export function createRoutes({ health, cluster, chaos }) {
  return {
    "/healthz": { GET: health.check },
    "/api/cluster": { GET: cluster.get },
    "/api/chaos": { POST: chaos.evict },
  };
}
