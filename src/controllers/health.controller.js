// GET /healthz, for the probes.
// It never calls Kubernetes, so a slow API server can't get healthy pods restarted.
export function createHealthController() {
  return {
    check: async () => ({ status: 200, body: { ok: true } }),
  };
}
