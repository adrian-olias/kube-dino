// The rules that make the public chaos button safe.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseVictim } from "../src/services/chaos.service.js";
import { NOW, pod } from "./pods.js";

const options = { self: "a", now: NOW, cooldownSeconds: 30, random: () => 0 };

test("evicts a ready pod that is not the one answering", () => {
  assert.deepEqual(chooseVictim([pod("a"), pod("b"), pod("c")], options), { victim: "b" });
  assert.deepEqual(chooseVictim([pod("a"), pod("b"), pod("c")], { ...options, random: () => 0.99 }), { victim: "c" });
});

test("waits until every pod has been ready for the whole cooldown", () => {
  assert.deepEqual(chooseVictim([pod("a"), pod("b", { readyFor: 12 }), pod("c")], options), { retryAfter: 18 });
});

test("waits while a pod is recovering or terminating", () => {
  assert.deepEqual(chooseVictim([pod("a"), pod("b", { readyFor: null }), pod("c")], options), { retryAfter: 5 });
  assert.deepEqual(chooseVictim([pod("a"), pod("b", { terminating: true }), pod("c")], options), { retryAfter: 5 });
});

test("never evicts the last pod", () => {
  assert.deepEqual(chooseVictim([pod("a")], options), { retryAfter: 5 });
  assert.deepEqual(chooseVictim([], options), { retryAfter: 5 });
});
