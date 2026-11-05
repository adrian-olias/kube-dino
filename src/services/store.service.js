// The file behind the game totals: one small JSON document.
//
//   { "version": 1, "played": 327, "best": 12480, "counted": { "<game id>": <ms> } }
//
// Writes run one at a time. Each goes to a temp file in the same directory,
// is flushed to disk, renamed over the old file, and the directory flushed,
// so after a crash the file holds the old state or the new one, never a mix.
//
// The file is the truth. If a write fails at any step, the state is read back
// from the file; if that fails too, the store stops taking writes until the
// pod restarts, instead of writing from a state that may differ from the file.
import { promises as fsp } from "node:fs";
import { basename, dirname, join } from "node:path";

const VERSION = 1;

export class StoreUnavailable extends Error {}

const nodeFs = {
  readFile: (path) => fsp.readFile(path, "utf8"),
  // Writes and flushes the file before returning.
  async writeSynced(path, data) {
    const file = await fsp.open(path, "w");
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
  },
  rename: (from, to) => fsp.rename(from, to),
  unlink: (path) => fsp.unlink(path),
  // Makes the rename itself durable. Windows can't open a directory; there
  // this only matters for local runs.
  async syncDir(dir) {
    if (process.platform === "win32") return;
    const handle = await fsp.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

export async function openStore(path, { fs = nodeFs, log = () => {} } = {}) {
  const dir = dirname(path);
  const restorePath = join(dir, `${basename(path, ".json")}.restore.json`);
  let state = null;
  let reason = null; // why the store is unavailable, or null when it works
  let closed = false;
  let queue = Promise.resolve();

  async function write(next) {
    const tmp = join(dir, `.${basename(path)}.tmp`);
    await fs.writeSynced(tmp, JSON.stringify(next));
    await fs.rename(tmp, path);
    await fs.syncDir(dir);
  }

  // The parsed file, null if it doesn't exist; throws if it can't be trusted.
  async function read(file) {
    let text;
    try {
      text = await fs.readFile(file);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    const parsed = JSON.parse(text);
    if (!isValid(parsed)) throw new Error(`${file} has an unexpected format`);
    return parsed;
  }

  function fail(why, err) {
    reason = why;
    log({ msg: "game store unavailable", reason: why, path, error: err.message });
  }

  try {
    // A restore file left next to the data replaces it, once, at startup.
    const restored = await read(restorePath);
    if (restored) {
      await write(restored);
      await fs.unlink(restorePath);
      log({ msg: "game store restored", path, played: restored.played, best: restored.best });
    }
    state = restored ?? (await read(path));
    if (!state) {
      // First start: writing the empty state also proves /data is writable.
      state = { version: VERSION, played: 0, best: 0, counted: {} };
      await write(state);
    } else {
      // Existing file: check we can still write next to it, without touching it.
      const probe = join(dir, ".write-test");
      await fs.writeSynced(probe, "ok");
      await fs.unlink(probe);
    }
  } catch (err) {
    // Never start from zero over a file we couldn't read: leave it as it is.
    fail("could not open", err);
  }

  return {
    get available() {
      return !reason && !closed;
    },
    get state() {
      return state;
    },

    // Runs change(copy of the state) in the queue. change returns the new
    // state, or null for no change. Resolves to true if something was saved.
    update(change) {
      // Once closing, refuse new writes; the ones already queued still run.
      if (closed) return Promise.reject(new StoreUnavailable("closing"));
      const run = queue.then(async () => {
        if (reason) throw new StoreUnavailable(reason);
        const next = change(structuredClone(state));
        if (!next) return false;
        try {
          await write(next);
          state = next;
          return true;
        } catch (err) {
          log({ msg: "game store write failed", path, error: err.message });
          try {
            // The rename may have happened: take whatever the file holds now.
            state = (await read(path)) ?? state;
          } catch (readErr) {
            fail("file unreadable after a failed write", readErr);
          }
          throw new StoreUnavailable("write failed");
        }
      });
      // A failed write must not block the ones after it.
      queue = run.catch(() => {});
      return run;
    },

    // Stops taking writes and waits for the queued ones (on SIGTERM).
    close() {
      closed = true;
      return queue;
    },
  };
}

function isValid(s) {
  const count = (n) => Number.isInteger(n) && n >= 0;
  return s?.version === VERSION && count(s.played) && count(s.best) &&
    typeof s.counted === "object" && s.counted !== null && !Array.isArray(s.counted) &&
    Object.values(s.counted).every(count);
}
