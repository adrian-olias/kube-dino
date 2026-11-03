// POST /api/chaos → 200 { killed } or 429 { retryAfter }.
export function createChaosController({ chaosService }) {
  return {
    evict: async () => {
      const { killed, retryAfter } = await chaosService.evictOne();
      if (killed) return { status: 200, body: { killed } };
      return { status: 429, body: { retryAfter }, headers: { "Retry-After": String(retryAfter) } };
    },
  };
}
