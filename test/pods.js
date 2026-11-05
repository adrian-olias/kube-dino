// Builds Pod objects shaped like the Kubernetes API returns them.

export const NOW = Date.parse("2026-11-02T20:00:00Z");

export function pod(name, { ready = true, terminating = false, created = "2026-11-02T19:00:00Z", restarts = 0 } = {}) {
  return {
    metadata: {
      name,
      creationTimestamp: created,
      ...(terminating ? { deletionTimestamp: "2026-11-02T19:59:59Z" } : {}),
    },
    spec: { containers: [{ image: "ghcr.io/adrian-olias/kube-dino:0.2.0" }] },
    status: {
      phase: "Running",
      startTime: created,
      conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
      containerStatuses: [{ restartCount: restarts, state: { running: {} } }],
    },
  };
}
