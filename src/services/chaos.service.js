// The chaos button: evicts one of the app's pods, but only when it's safe.
import { isReady, isTerminating, readySince } from "../models/pod.model.js";

const RECOVERING_RETRY_SECONDS = 5; // a pod is starting or stopping
const PDB_RETRY_SECONDS = 10; // the PodDisruptionBudget refused

// Returns { victim } or { retryAfter }. The rules:
// - at least 2 pods, all ready, none terminating;
// - all of them ready for the whole cooldown;
// - never the pod handling this request (`self`).
// The cooldown is read from the pods themselves, so every replica agrees on it.
export function chooseVictim(pods, { self, now, cooldownSeconds, random = Math.random }) {
  const live = pods.filter((p) => !isTerminating(p));
  if (live.length < 2 || live.length !== pods.length || !live.every(isReady)) {
    return { retryAfter: RECOVERING_RETRY_SECONDS };
  }

  const lastReadyAt = Math.max(...live.map((p) => readySince(p, now)));
  const wait = Math.ceil(cooldownSeconds - (now - lastReadyAt) / 1000);
  if (wait > 0) return { retryAfter: wait };

  const candidates = live.filter((p) => p.metadata.name !== self);
  return { victim: candidates[Math.floor(random() * candidates.length)].metadata.name };
}

// If two requests arrive at once, the PodDisruptionBudget refuses the second eviction.
export function createChaosService({ kubernetes, clusterService, namespace, selector, self, cooldownSeconds, now, log }) {
  return {
    async evictOne() {
      const pods = await kubernetes.listPods(namespace, selector);
      const { victim, retryAfter } = chooseVictim(pods, { self, now: now(), cooldownSeconds });
      if (!victim) return { retryAfter };

      const evicted = await kubernetes.evictPod(namespace, victim);
      if (!evicted) return { retryAfter: PDB_RETRY_SECONDS };

      clusterService.invalidate();
      log({ msg: "evicted", pod: victim });
      return { killed: victim };
    },
  };
}
