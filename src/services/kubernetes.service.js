// The Kubernetes API calls the app needs: list pods, read their metrics, evict one.
//
// In the cluster it authenticates with the pod's ServiceAccount token, and
// trusts the cluster CA through NODE_EXTRA_CA_CERTS (set in the Dockerfile).
// With apiUrl, e.g. `kubectl proxy`, the proxy handles authentication.
import { readFileSync } from "node:fs";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export function createKubernetesService({ apiUrl, timeoutMs = 5000 } = {}) {
  const baseUrl = apiUrl ?? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`;
  const query = (selector) => `?labelSelector=${encodeURIComponent(selector)}`;

  async function request(method, path, body) {
    const headers = { Accept: "application/json" };
    // The token rotates, so it's read on every call.
    if (!apiUrl) headers.Authorization = `Bearer ${readFileSync(`${SA_DIR}/token`, "utf8").trim()}`;
    if (body) headers["Content-Type"] = "application/json";

    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers,
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  return {
    async listPods(namespace, selector) {
      const res = await request("GET", `/api/v1/namespaces/${namespace}/pods${query(selector)}`);
      if (res.status !== 200) throw new Error(`listing pods returned ${res.status}`);
      return res.json.items;
    },

    // null when metrics-server is missing or not ready yet.
    async listPodMetrics(namespace, selector) {
      try {
        const res = await request("GET", `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods${query(selector)}`);
        return res.status === 200 ? res.json.items : null;
      } catch {
        return null;
      }
    },

    // Uses the Eviction API, so the PodDisruptionBudget can refuse.
    // Returns false when it does.
    async evictPod(namespace, name) {
      const res = await request("POST", `/api/v1/namespaces/${namespace}/pods/${encodeURIComponent(name)}/eviction`, {
        apiVersion: "policy/v1",
        kind: "Eviction",
        metadata: { name, namespace },
      });
      if (res.status === 429) return false;
      if (res.status !== 200 && res.status !== 201) throw new Error(`evicting ${name} returned ${res.status}`);
      return true;
    },
  };
}

export function inClusterNamespace() {
  return readFileSync(`${SA_DIR}/namespace`, "utf8").trim();
}
