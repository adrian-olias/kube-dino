// The game rules: presence, expiry, single use, plausible scores and retries.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGamesService } from "../src/services/games.service.js";
import { openStore } from "../src/services/store.service.js";

async function setup({ path, maxCounted } = {}) {
  path ??= join(await mkdtemp(join(tmpdir(), "kube-dino-")), "games.json");
  const clock = { t: Date.parse("2026-11-04T10:00:00Z") };
  const store = await openStore(path);
  const games = createGamesService({ now: () => clock.t, store, maxCounted });
  const wait = (seconds) => (clock.t += seconds * 1000);
  return { games, store, wait, path };
}

test("a running game counts as playing until its heartbeats stop", async () => {
  const { games, wait } = await setup();
  const id = games.start();
  wait(10);
  assert.equal(games.heartbeat(id), true);
  wait(10);
  assert.equal(games.stats().playing, 1);
  wait(6); // 16 s since the last heartbeat
  assert.equal(games.stats().playing, 0);
  assert.equal(games.heartbeat(id), false);
});

test("a finished game counts once and updates the best score", async () => {
  const { games, wait } = await setup();
  const id = games.start();
  wait(10);
  assert.equal(await games.finish(id, 600), "counted");
  assert.equal(await games.finish(id, 600), "duplicate");
  assert.deepEqual(games.stats(), { playing: 0, played: 1, best: 600 });
});

test("the same game finished twice at once counts once", async () => {
  const { games, wait } = await setup();
  const id = games.start();
  wait(10);
  const results = await Promise.all([games.finish(id, 300), games.finish(id, 300)]);
  assert.deepEqual(results.sort(), ["counted", "duplicate"]);
  assert.equal(games.stats().played, 1);
});

test("a retry after a restart is recognised, though its session is gone", async () => {
  const first = await setup();
  const id = first.games.start();
  first.wait(10);
  assert.equal(await first.games.finish(id, 420), "counted");

  const second = await setup({ path: first.path }); // a new pod: no sessions in memory
  assert.equal(await second.games.finish(id, 420), "duplicate");
  assert.deepEqual(second.games.stats(), { playing: 0, played: 1, best: 420 });
});

test("a score the game can't reach in that time is not counted", async () => {
  const { games, wait } = await setup();
  const id = games.start();
  wait(5);
  assert.equal(await games.finish(id, 12_480), "rejected");
  assert.equal(await games.finish(games.start(), -1), "rejected");
  assert.equal(await games.finish(games.start(), "100"), "rejected");
  assert.deepEqual(games.stats(), { playing: 0, played: 0, best: 0 });
});

test("an expired game can't be finished", async () => {
  const { games, wait } = await setup();
  const id = games.start();
  wait(20);
  assert.equal(await games.finish(id, 10), "unknown");
  assert.equal(games.stats().played, 0);
});

test("counted ids are kept for 24 hours or the last maxCounted, whichever is fewer", async () => {
  const { games, store, wait } = await setup({ maxCounted: 3 });
  const finishOne = async () => {
    const id = games.start();
    wait(1);
    await games.finish(id, 10);
    return id;
  };
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await finishOne());
  assert.deepEqual(Object.keys(store.state.counted), ids.slice(1)); // the cap dropped the oldest

  wait(25 * 3600);
  const last = await finishOne();
  assert.deepEqual(Object.keys(store.state.counted), [last]); // the window dropped the rest
  assert.equal(store.state.played, 5);
});

test("without a store, games play but aren't counted", async () => {
  const { games } = await setup();
  const unavailable = { available: false, state: null };
  const offline = createGamesService({ now: Date.now, store: unavailable });
  assert.equal(offline.start(), null);
  assert.equal(offline.stats(), null);
  assert.ok(games.start());
});
