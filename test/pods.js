// Builds Pod objects shaped like the Kubernetes API returns them.

export const NOW = Date.parse("2026-11-02T20:00:00Z");

export function pod(name, { readyFor = 600, terminating = false, created = "2026-11-02T19:00:00Z" } = {}) {
  return {
    metadata: {
      name,
      creationTimestamp: created,
      ...(terminating ? { deletionTimestamp: "2026-11-02T19:59:59Z" } : {}),
    },
    status: {
      phase: "Running",
      // readyFor: seconds since the pod became ready, or null when it is not ready.
      conditions: readyFor === null ? [] : [
        { type: "Ready", status: "True", lastTransitionTime: new Date(NOW - readyFor * 1000).toISOString() },
      ],
    },
  };
}
