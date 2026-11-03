// The whole API over HTTP, with a fake Kubernetes service behind it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "../src/server.js";
import { NOW, pod } from "./pods.js";

const fake = {};
const kubernetes = {
  listPods: async () => {
    if (fake.down) throw new Error("listing pods returned 500");
    return fake.pods;
  },
  listPodMetrics: async () => [{ containers: [{ usage: { cpu: "4000000n", memory: "40Mi" } }] }],
  evictPod: async () => fake.evicted,
};

function reset(pods) {
  Object.assign(fake, { pods, evicted: true, down: false });
}

let server;
let base;
before(async () => {
  const config = { namespace: "kube-dino-prod", selector: "app=x", self: "kube-dino-a", cooldownSeconds: 30, cacheMs: 0 };
  server = createApp({ config, kubernetes, now: () => NOW, log: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("GET /api/cluster lists the pods with their usage", async () => {
  reset([pod("kube-dino-b", { created: "2026-11-02T19:30:00Z" }), pod("kube-dino-a")]);
  const res = await fetch(`${base}/api/cluster`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), {
    pods: [
      { name: "kube-dino-a", phase: "Running", ready: true },
      { name: "kube-dino-b", phase: "Running", ready: true },
    ],
    cpu: 4,
    memory: 40 * 2 ** 20,
  });
});

test("POST /api/chaos evicts another pod", async () => {
  reset([pod("kube-dino-a"), pod("kube-dino-b")]);
  const res = await fetch(`${base}/api/chaos`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { killed: "kube-dino-b" });
});

test("POST /api/chaos answers 429 with Retry-After during the cooldown", async () => {
  reset([pod("kube-dino-a"), pod("kube-dino-b", { readyFor: 10 })]);
  const res = await fetch(`${base}/api/chaos`, { method: "POST" });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "20");
  assert.deepEqual(await res.json(), { retryAfter: 20 });
});

test("POST /api/chaos answers 429 when the PodDisruptionBudget refuses", async () => {
  reset([pod("kube-dino-a"), pod("kube-dino-b")]);
  fake.evicted = false;
  const res = await fetch(`${base}/api/chaos`, { method: "POST" });
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { retryAfter: 10 });
});

test("a Kubernetes API failure is a 503", async () => {
  reset([]);
  fake.down = true;
  assert.equal((await fetch(`${base}/api/cluster`)).status, 503);
  assert.equal((await fetch(`${base}/api/chaos`, { method: "POST" })).status, 503);
});

test("other routes and methods are rejected", async () => {
  reset([pod("kube-dino-a")]);
  assert.equal((await fetch(`${base}/api/pods`)).status, 404);
  const res = await fetch(`${base}/api/chaos`);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});
