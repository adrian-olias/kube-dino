// Minimal HTTP helpers on top of node:http.

// Thrown by controllers to answer with that status and message.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

// Reads a small JSON body: more than `limit` bytes is a 413, invalid JSON a 400.
export async function readJson(req, limit = 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

// Builds the request handler from the route table. A ":name" segment matches
// any value and reaches the controller as params.name.
// Controllers return { status, body, headers }.
// Unknown path → fallback (the page files) or 404, wrong method → 405, HttpError → its status, any other error → 503.
export function createRouter(routes, { log, fallback }) {
  const table = Object.entries(routes).map(([pattern, methods]) => ({ segments: pattern.split("/"), methods }));

  function match(pathname) {
    const segments = pathname.split("/");
    for (const route of table) {
      if (route.segments.length !== segments.length) continue;
      const params = {};
      const matches = route.segments.every((part, i) => {
        if (!part.startsWith(":")) return part === segments[i];
        params[part.slice(1)] = segments[i];
        return segments[i] !== "";
      });
      if (matches) return { methods: route.methods, params };
    }
    return null;
  }

  return async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    const route = match(pathname);
    if (!route) return fallback ? fallback(req, res) : sendJson(res, 404, { error: "not found" });

    const controller = route.methods[req.method];
    if (!controller) {
      return sendJson(res, 405, { error: "method not allowed" }, { Allow: Object.keys(route.methods).join(", ") });
    }

    try {
      const { status, body, headers } = await controller(req, route.params);
      sendJson(res, status, body, headers);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      // Only the Kubernetes API can fail like this.
      log({ msg: "request failed", path: pathname, error: err.message });
      sendJson(res, 503, { error: "cluster unavailable" });
    }
  };
}
