// GET /api/cluster → the app's pods and their CPU and memory.
export function createClusterController({ clusterService }) {
  return {
    get: async () => ({ status: 200, body: await clusterService.snapshot() }),
  };
}
