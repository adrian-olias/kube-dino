// Minimal HTTP helpers on top of node:http.

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

// Builds the request handler from the route table.
// Controllers return { status, body, headers }.
// Unknown path → 404, wrong method → 405, any error → 503.
export function createRouter(routes, { log }) {
  return async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    const route = routes[pathname];
    if (!route) return sendJson(res, 404, { error: "not found" });

    const controller = route[req.method];
    if (!controller) {
      return sendJson(res, 405, { error: "method not allowed" }, { Allow: Object.keys(route).join(", ") });
    }

    try {
      const { status, body, headers } = await controller(req);
      sendJson(res, status, body, headers);
    } catch (err) {
      // Only the Kubernetes API can fail here.
      log({ msg: "request failed", path: pathname, error: err.message });
      sendJson(res, 503, { error: "cluster unavailable" });
    }
  };
}
