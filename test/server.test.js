// The whole API over HTTP, with a fake Kubernetes service behind it.
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../src/server.js";
import { openStore } from "../src/services/store.service.js";
import { NOW, pod } from "./pods.js";

// Real files in a temp directory; failAfterRename makes the next write fail
// once the new file is already in place.
const disk = { failAfterRename: false };
const fs = {
  readFile: (path) => fsp.readFile(path, "utf8"),
  writeSynced: (path, data) => fsp.writeFile(path, data),
  rename: (from, to) => fsp.rename(from, to),
  unlink: (path) => fsp.unlink(path),
  syncDir: async () => {
    if (disk.failAfterRename) {
      disk.failAfterRename = false;
      throw new Error("EIO");
    }
  },
};

const fake = {};
const kubernetes = {
  listPods: async () => {
    if (fake.down) throw new Error("listing pods returned 500");
    return fake.pods;
  },
  listPodMetrics: async () => [{ containers: [{ usage: { cpu: "4000000n", memory: "40Mi" } }] }],
};

function reset(pods) {
  Object.assign(fake, { pods, down: false });
}

const clock = { t: NOW };
let server;
let base;
before(async () => {
  const config = { namespace: "kube-dino-prod", selector: "app=x", cacheMs: 0 };
  const store = await openStore(join(await mkdtemp(join(tmpdir(), "kube-dino-")), "games.json"), { fs });
  server = createApp({ config, kubernetes, store, now: () => clock.t, log: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body) => fetch(`${base}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test("GET /api/cluster lists the pods with their usage", async () => {
  reset([pod("kube-dino-b", { created: "2026-11-02T19:30:00Z", restarts: 2 }), pod("kube-dino-a")]);
  const res = await fetch(`${base}/api/cluster`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const view = (name, startedAt, restarts) => ({ name, status: "Running", ready: true, startedAt, restarts, version: "0.2.0" });
  assert.deepEqual(await res.json(), {
    pods: [view("kube-dino-a", "2026-11-02T19:00:00Z", 0), view("kube-dino-b", "2026-11-02T19:30:00Z", 2)],
    cpu: 4,
    memory: 40 * 2 ** 20,
  });
});

test("a game goes from start to finish and shows up in the totals", async () => {
  const start = await post("/api/games");
  assert.equal(start.status, 201);
  const { id, heartbeatSeconds } = await start.json();
  assert.equal(heartbeatSeconds, 5);
  assert.deepEqual(await (await fetch(`${base}/api/games`)).json(), { playing: 1, played: 0, best: 0 });

  clock.t += 5000;
  assert.equal((await post(`/api/games/${id}/heartbeat`)).status, 200);
  clock.t += 5000;
  const finish = await post(`/api/games/${id}/finish`, { score: 420 });
  assert.equal(finish.status, 200);
  assert.deepEqual(await finish.json(), { playing: 0, played: 1, best: 420 });

  // A retry gets the same answer without counting twice; unknown ids are refused.
  const retry = await post(`/api/games/${id}/finish`, { score: 420 });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).played, 1);
  assert.equal((await post("/api/games/nope/finish", { score: 1 })).status, 404);
  assert.equal((await post("/api/games/nope/heartbeat")).status, 404);
});

test("a save that fails after the rename is a 503, and the retry is counted once", async () => {
  const { id } = await (await post("/api/games")).json();
  clock.t += 5000;
  const before = (await (await fetch(`${base}/api/games`)).json()).played;

  disk.failAfterRename = true;
  assert.equal((await post(`/api/games/${id}/finish`, { score: 200 })).status, 503);
  const retry = await post(`/api/games/${id}/finish`, { score: 200 });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).played, before + 1);
});

test("bad game results are refused", async () => {
  const { id } = await (await post("/api/games")).json();
  assert.equal((await post(`/api/games/${id}/finish`, { score: 99_999 })).status, 422);

  const other = (await (await post("/api/games")).json()).id;
  const invalid = await fetch(`${base}/api/games/${other}/finish`, { method: "POST", body: "{" });
  assert.equal(invalid.status, 400);
  const huge = await post(`/api/games/${other}/finish`, { score: 1, pad: "x".repeat(2000) });
  assert.equal(huge.status, 413);
});

test("a Kubernetes API failure is a 503 and leaves the games working", async () => {
  reset([]);
  fake.down = true;
  assert.equal((await fetch(`${base}/api/cluster`)).status, 503);
  assert.equal((await fetch(`${base}/api/games`)).status, 200);
});

test("other routes and methods are rejected", async () => {
  assert.equal((await fetch(`${base}/api/chaos`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`${base}/api/games/x/heartbeat/more`, { method: "POST" })).status, 404);
  const res = await fetch(`${base}/api/games/x/finish`);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});
