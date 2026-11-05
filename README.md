# kube-dino

API behind the Kube Dino panel on the [portfolio](https://github.com/adrian-olias/portfolio).
It shows the app's own pods and counts the games played in the browser.

Plain Node.js with no dependencies, running on a distroless image.

## Endpoints

| Route | What it does |
|---|---|
| `GET /api/cluster` | Pods of the app (status, uptime, restarts, version), plus CPU and memory |
| `GET /api/games` | Players now, games played and the best score |
| `POST /api/games` | Starts a game and returns its id |
| `POST /api/games/:id/heartbeat` | Keeps a running game alive |
| `POST /api/games/:id/finish` | Ends a game with `{"score": 420}` |
| `GET /healthz` | Health check |

The page treats this API as optional: if it is down, the game plays as usual.

## Games

- **Presence.** The page sends a heartbeat every 5 seconds while a game runs.
  A game with no heartbeat for 15 seconds is gone: it stops counting as playing
  and can't be finished. Presence lives in memory, so "playing now" rebuilds
  within seconds after a restart.
- **Sessions.** The server creates the id. A game lasts at most 30 minutes and
  there are at most 500 open at once; past that, new games play without counting.
- **Games played.** A game counts when it is finished while still alive, with a
  plausible score, and only once it is saved to disk. Abandoned games don't count.
- **Plausible scores.** At most 100 points per second since the game started,
  plus 50. The game can't score faster, so anything above is refused with 422.
  This stops crude cheating, not someone who keeps a fake game alive for minutes.
- **Retries and duplicates.** Finishing a game that was already saved answers
  200 with the totals and counts nothing, also after a restart. Saved ids are
  remembered for **24 hours or the last 50,000 games, whichever is fewer**.
  A game can only be finished within 30 minutes of starting, so a retry that
  could count twice always falls inside that window unless more than 50,000
  games finish in those 30 minutes.

## Storage

Totals and the remembered ids are one JSON file, `DATA_FILE`, on a
PersistentVolumeClaim. In prod: `/data/games.json`, one replica, `Recreate`.

- **Writes** run one at a time: check, compute the new state, save, and only
  then answer. Each save writes a temp file in the same directory, flushes it,
  renames it over the old one and flushes the directory. After a crash the file
  holds the old state or the new one. After a power cut, what was saved stays
  saved as long as the disk honours flushes.
- **A failed save** answers 503 and the game stays open for a retry. The state
  is then read back from the file, because the rename may already have happened.
  If the file can't be read back, the store stops taking writes until the pod
  restarts.
- **At startup** a missing file means a new install: it starts from zero.
  A file that can't be read, isn't valid JSON or has an unexpected format is
  left untouched; the app logs `game store unavailable` and serves the panel
  without counting games. Fix or restore the file, then restart the pod.
- **On SIGTERM** the app stops taking writes and finishes the ones queued.
  `Recreate` keeps rollouts to one pod at a time; when a pod is deleted, its
  replacement can start while it terminates, and this keeps the old pod's last
  write to the milliseconds after SIGTERM, before the new container is up.

### Backup

The file is replaced atomically, so it can be copied while the app runs.

```bash
PV=$(kubectl get pvc -n kube-dino-prod kube-dino-data -o jsonpath='{.spec.volumeName}')
DIR=$(kubectl get pv "$PV" -o jsonpath='{.spec.hostPath.path}{.spec.local.path}')
ssh vps "sudo cat $DIR/games.json" > games-backup.json
```

### Restore

Argo CD self-heals the ApplicationSet, the `prod` app and `kube-dino`, so
scaling to zero or pausing a sync would be undone. Instead, leave a restore
file next to the data and restart the pod; nothing Argo CD manages changes.

```bash
ssh vps "sudo tee $DIR/games.restore.json > /dev/null" < games-backup.json
kubectl delete pod -n kube-dino-prod -l app.kubernetes.io/name=kube-dino
kubectl logs -n kube-dino-prod -l app.kubernetes.io/name=kube-dino | grep 'game store'
```

At startup the new pod checks the restore file, saves it as `games.json` and
deletes it (log: `game store restored`). An invalid restore file is left in
place and the store stays unavailable, without touching `games.json`.

### Deleting the PVC

Argo CD never deletes or prunes it (`Delete=false,Prune=false`). local-path
deletes the data with the PVC, so take a backup before `kubectl delete pvc`.

## Run locally

```bash
cp .env.example .env
mkdir -p data
kubectl proxy &
npm start
```

## Test

```bash
npm test
```

## Release

Push a tag like `v0.2.0`. CI runs the tests and publishes
`ghcr.io/adrian-olias/kube-dino:0.2.0`.
