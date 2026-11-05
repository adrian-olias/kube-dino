// The game store on a real temp directory, with failures injected into its file calls.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openStore, StoreUnavailable } from "../src/services/store.service.js";

const fs = {
  readFile: (path) => fsp.readFile(path, "utf8"),
  writeSynced: (path, data) => fsp.writeFile(path, data),
  rename: (from, to) => fsp.rename(from, to),
  unlink: (path) => fsp.unlink(path),
  syncDir: async () => {},
};

async function dataFile() {
  return join(await mkdtemp(join(tmpdir(), "kube-dino-")), "games.json");
}

const addGame = (state) => ({ ...state, played: state.played + 1 });
const onDisk = async (path) => JSON.parse(await readFile(path, "utf8"));

test("a missing file starts from zero and is created", async () => {
  const path = await dataFile();
  const store = await openStore(path, { fs });
  assert.equal(store.available, true);
  assert.deepEqual(await onDisk(path), { version: 1, played: 0, best: 0, counted: {} });
});

test("an existing file survives a restart", async () => {
  const path = await dataFile();
  const first = await openStore(path, { fs });
  await first.update(addGame);
  const second = await openStore(path, { fs });
  assert.equal(second.state.played, 1);
});

test("a corrupt or unexpected file is left untouched and the store is unavailable", async () => {
  for (const content of ["{ not json", JSON.stringify({ version: 2, played: 3 }), JSON.stringify({ version: 1, played: -1, best: 0, counted: {} })]) {
    const path = await dataFile();
    await writeFile(path, content);
    const logs = [];
    const store = await openStore(path, { fs, log: (l) => logs.push(l) });
    assert.equal(store.available, false);
    assert.equal(await readFile(path, "utf8"), content);
    assert.equal(logs[0].msg, "game store unavailable");
    await assert.rejects(store.update(addGame), StoreUnavailable);
    assert.equal(await readFile(path, "utf8"), content);
  }
});

test("a directory it can't write to makes the store unavailable", async () => {
  const path = await dataFile();
  await writeFile(path, JSON.stringify({ version: 1, played: 5, best: 9, counted: {} }));
  const store = await openStore(path, {
    fs: { ...fs, writeSynced: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } },
  });
  assert.equal(store.available, false);
});

test("concurrent updates are applied one after another", async () => {
  const path = await dataFile();
  const store = await openStore(path, { fs });
  await Promise.all(Array.from({ length: 50 }, () => store.update(addGame)));
  assert.equal(store.state.played, 50);
  assert.equal((await onDisk(path)).played, 50);
});

test("a write that fails before the rename changes nothing and doesn't block the queue", async () => {
  const path = await dataFile();
  let failNext = false;
  const store = await openStore(path, {
    fs: { ...fs, writeSynced: async (p, d) => { if (failNext) { failNext = false; throw new Error("ENOSPC"); } return fs.writeSynced(p, d); } },
  });
  failNext = true;
  await assert.rejects(store.update(addGame), StoreUnavailable);
  assert.equal(store.state.played, 0);
  assert.equal((await onDisk(path)).played, 0);

  await store.update(addGame);
  assert.equal(store.state.played, 1);
  assert.equal((await onDisk(path)).played, 1);
});

test("a write that fails after the rename takes the state from the file", async () => {
  const path = await dataFile();
  let failNext = false;
  const store = await openStore(path, {
    fs: { ...fs, syncDir: async () => { if (failNext) { failNext = false; throw new Error("EIO"); } } },
  });
  failNext = true;
  await assert.rejects(store.update(addGame), StoreUnavailable);
  // The file has the new state, and so does memory: the next write builds on it.
  assert.equal(store.state.played, 1);
  await store.update(addGame);
  assert.equal((await onDisk(path)).played, 2);
});

test("if the file can't be read back after a failed write, the store stops taking writes", async () => {
  const path = await dataFile();
  let broken = false;
  const store = await openStore(path, {
    fs: {
      ...fs,
      syncDir: async () => { if (broken) throw new Error("EIO"); },
      readFile: async (p) => { if (broken) throw new Error("EIO"); return fs.readFile(p); },
    },
  });
  broken = true;
  await assert.rejects(store.update(addGame), StoreUnavailable);
  assert.equal(store.available, false);
  broken = false;
  await assert.rejects(store.update(addGame), StoreUnavailable);
});

test("a restore file replaces the data at startup, once", async () => {
  const path = await dataFile();
  await (await openStore(path, { fs })).update(addGame);
  const backup = { version: 1, played: 327, best: 12480, counted: {} };
  await writeFile(path.replace("games.json", "games.restore.json"), JSON.stringify(backup));

  const store = await openStore(path, { fs });
  assert.deepEqual(store.state, backup);
  assert.deepEqual(await onDisk(path), backup);
  await assert.rejects(readFile(path.replace("games.json", "games.restore.json")), { code: "ENOENT" });
});

test("an invalid restore file is left in place and the data untouched", async () => {
  const path = await dataFile();
  await (await openStore(path, { fs })).update(addGame);
  const restore = path.replace("games.json", "games.restore.json");
  await writeFile(restore, "{ broken");

  const store = await openStore(path, { fs });
  assert.equal(store.available, false);
  assert.equal(await readFile(restore, "utf8"), "{ broken");
  assert.equal((await onDisk(path)).played, 1);
});

test("close stops new writes after the one in progress", async () => {
  const path = await dataFile();
  const store = await openStore(path, { fs });
  const inProgress = store.update(addGame);
  await store.close();
  await inProgress;
  await assert.rejects(store.update(addGame), StoreUnavailable);
  assert.equal((await onDisk(path)).played, 1);
});
