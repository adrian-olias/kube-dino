// Settings from environment variables.
// In prod they come from the ConfigMap in helm-charts-wrappers; locally, from .env.
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 8080),
    selector: required(env, "POD_SELECTOR"),
    cooldownSeconds: Number(required(env, "COOLDOWN_SECONDS")),
    namespace: env.NAMESPACE, // if unset, read from the ServiceAccount
    self: env.HOSTNAME ?? "", // set by Kubernetes: the pod's own name
    apiUrl: env.KUBE_API_URL, // only outside the cluster, e.g. `kubectl proxy`
    cacheMs: 2000,
  };
}

// Fails at startup instead of running with a guessed value.
function required(env, name) {
  if (!env[name]) throw new Error(`${name} is required`);
  return env[name];
}
