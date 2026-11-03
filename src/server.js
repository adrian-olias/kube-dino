// Builds the app (services → controllers → routes) and, when run directly, starts it.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createChaosController } from "./controllers/chaos.controller.js";
import { createClusterController } from "./controllers/cluster.controller.js";
import { createHealthController } from "./controllers/health.controller.js";
import { createRoutes } from "./routes/index.js";
import { createChaosService } from "./services/chaos.service.js";
import { createClusterService } from "./services/cluster.service.js";
import { createKubernetesService, inClusterNamespace } from "./services/kubernetes.service.js";
import { createRouter } from "./utils/http.js";

// Logs one JSON object per line.
const jsonLog = (fields) => console.log(JSON.stringify(fields));

export function createApp({ config, kubernetes, now = Date.now, log = jsonLog }) {
  const { namespace, selector, self, cooldownSeconds, cacheMs } = config;

  const clusterService = createClusterService({ kubernetes, namespace, selector, cacheMs, now });
  const chaosService = createChaosService({ kubernetes, clusterService, namespace, selector, self, cooldownSeconds, now, log });

  const routes = createRoutes({
    health: createHealthController(),
    cluster: createClusterController({ clusterService }),
    chaos: createChaosController({ chaosService }),
  });

  return createServer(createRouter(routes, { log }));
}

function start() {
  const config = loadConfig();
  config.namespace ??= inClusterNamespace();

  const server = createApp({ config, kubernetes: createKubernetesService({ apiUrl: config.apiUrl }) });
  server.listen(config.port, () => jsonLog({ msg: "listening", port: config.port, namespace: config.namespace }));

  // Kubernetes sends SIGTERM before stopping the pod: finish open requests, then exit.
  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

// Start only with `node src/server.js`, not when a test imports this file.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) start();
