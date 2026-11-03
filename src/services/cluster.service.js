// Data for the panel: the app's pods and the CPU and memory they use.
import { byAge, toPodView } from "../models/pod.model.js";
import { cpuMillicores, memoryBytes } from "../utils/quantities.js";

// Pods oldest first, plus total CPU (millicores) and memory (bytes).
// cpu and memory are null when there are no metrics.
export function summarize(pods, metrics) {
  const containers = metrics?.flatMap((pod) => pod.containers ?? []) ?? [];
  const total = (read) => (metrics ? Math.round(containers.reduce((sum, c) => sum + read(c.usage), 0)) : null);

  return {
    pods: [...pods].sort(byAge).map(toPodView),
    cpu: total((usage) => cpuMillicores(usage?.cpu)),
    memory: total((usage) => memoryBytes(usage?.memory)),
  };
}

export function createClusterService({ kubernetes, namespace, selector, cacheMs, now }) {
  // Every visitor polls, so one answer is shared for cacheMs to spare the API server.
  let cached = null;

  return {
    snapshot() {
      if (cached && now() - cached.at < cacheMs) return cached.promise;

      const promise = Promise.all([
        kubernetes.listPods(namespace, selector),
        kubernetes.listPodMetrics(namespace, selector),
      ]).then(([pods, metrics]) => summarize(pods, metrics));

      cached = { at: now(), promise };
      // Don't keep a failed answer.
      promise.catch(() => {
        if (cached?.promise === promise) cached = null;
      });
      return promise;
    },

    // Called after an eviction, so the next poll shows it.
    invalidate() {
      cached = null;
    },
  };
}
