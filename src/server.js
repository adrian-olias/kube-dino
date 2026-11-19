// Builds the app (services → controllers → routes) and, when run directly, starts it.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createClusterController } from "./controllers/cluster.controller.js";
import { createGamesController } from "./controllers/games.controller.js";
import { createHealthController } from "./controllers/health.controller.js";
import { createRoutes } from "./routes/index.js";
import { createClusterService } from "./services/cluster.service.js";
import { createGamesService } from "./services/games.service.js";
import { createKubernetesService, inClusterNamespace } from "./services/kubernetes.service.js";
import { openStore } from "./services/store.service.js";
import { createRouter } from "./utils/http.js";
import { createStaticHandler } from "./utils/static.js";

// Logs one JSON object per line.
const jsonLog = (fields) => console.log(JSON.stringify(fields));

export function createApp({ config, kubernetes, store, now = Date.now, log = jsonLog }) {
  const { namespace, selector, cacheMs } = config;

  const routes = createRoutes({
    health: createHealthController(),
    cluster: createClusterController({ clusterService: createClusterService({ kubernetes, namespace, selector, cacheMs, now }) }),
    games: createGamesController({ gamesService: createGamesService({ now, store }) }),
  });

  // Paths the API doesn't know are the page and its assets, under /kube-dino and /es/kube-dino.
  return createServer(createRouter(routes, { log, fallback: createStaticHandler() }));
}

async function start() {
  const config = loadConfig();
  config.namespace ??= inClusterNamespace();

  // If the store can't open, the app still serves the panel; games just aren't counted.
  const store = await openStore(config.dataFile, { log: jsonLog });
  const server = createApp({ config, store, kubernetes: createKubernetesService({ apiUrl: config.apiUrl }) });
  server.listen(config.port, () => jsonLog({ msg: "listening", port: config.port, namespace: config.namespace }));

  // Kubernetes sends SIGTERM before stopping the pod. Writes stop first, so a
  // replacement pod that is already starting never sees this one write again.
  process.on("SIGTERM", async () => {
    setTimeout(() => process.exit(0), 10_000).unref();
    await store.close();
    server.close(() => process.exit(0));
  });
}

// Start only with `node src/server.js`, not when a test imports this file.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) start();
