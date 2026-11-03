// Helpers to read a Kubernetes Pod object.

export function isTerminating(pod) {
  return Boolean(pod.metadata.deletionTimestamp);
}

export function isReady(pod) {
  return !isTerminating(pod) && Boolean(readyCondition(pod));
}

// When the pod became ready, or `fallback` if it isn't ready.
export function readySince(pod, fallback) {
  const time = Date.parse(readyCondition(pod)?.lastTransitionTime);
  return Number.isNaN(time) ? fallback : time;
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

// What the API returns for each pod.
export function toPodView(pod) {
  return { name: pod.metadata.name, phase: podStatus(pod), ready: isReady(pod) };
}

// Sort order: oldest pod first.
export function byAge(a, b) {
  return a.metadata.creationTimestamp.localeCompare(b.metadata.creationTimestamp) ||
    a.metadata.name.localeCompare(b.metadata.name);
}

function readyCondition(pod) {
  return pod.status?.conditions?.find((c) => c.type === "Ready" && c.status === "True");
}
