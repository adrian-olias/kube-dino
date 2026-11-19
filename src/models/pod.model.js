// Helpers to read a Kubernetes Pod object.

export function isTerminating(pod) {
  return Boolean(pod.metadata.deletionTimestamp);
}

export function isReady(pod) {
  return !isTerminating(pod) &&
    Boolean(pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True"));
}

// Same as the STATUS column of `kubectl get pods`.
export function podStatus(pod) {
  if (isTerminating(pod)) return "Terminating";
  for (const { state } of pod.status?.containerStatuses ?? []) {
    const reason = state?.waiting?.reason ?? state?.terminated?.reason;
    if (reason) return reason;
  }
  return pod.status?.phase ?? "Unknown";
}

// Same as the RESTARTS column of `kubectl get pods`.
export function restarts(pod) {
  return (pod.status?.containerStatuses ?? []).reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
}

// The tag of the app's image, e.g. "0.2.0" for ghcr.io/<owner>/kube-dino:0.2.0.
export function version(pod) {
  const image = pod.spec?.containers?.[0]?.image?.split("@")[0];
  if (!image) return null;
  const colon = image.lastIndexOf(":");
  return colon > image.lastIndexOf("/") ? image.slice(colon + 1) : "latest";
}

// What the API returns for each pod. The page works out the uptime from startedAt.
export function toPodView(pod) {
  return {
    name: pod.metadata.name,
    status: podStatus(pod),
    ready: isReady(pod),
    startedAt: pod.status?.startTime ?? null,
    restarts: restarts(pod),
    version: version(pod),
  };
}

// Sort order: oldest pod first.
export function byAge(a, b) {
  return a.metadata.creationTimestamp.localeCompare(b.metadata.creationTimestamp) ||
    a.metadata.name.localeCompare(b.metadata.name);
}
