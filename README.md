# kube-dino

The Kube Dino page and the API behind its panel: the app's own pods and the games played.

One container serves both. The page is at `/kube-dino/` and `/es/kube-dino/`, the API at `/api/`.

## Endpoints

| Route | What it does |
|---|---|
| `GET /api/cluster` | Pods of the app, plus CPU and memory |
| `GET /api/games` | Players now, games played and best score |
| `POST /api/games` | Starts a game |
| `POST /api/games/:id/heartbeat` | Keeps a game alive |
| `POST /api/games/:id/finish` | Ends a game with `{"score": 420}` |
| `GET /healthz` | Health check |

## Run locally

```bash
kubectl proxy &
mkdir -p data
POD_SELECTOR=app.kubernetes.io/name=kube-dino \
DATA_FILE=./data/games.json NAMESPACE=kube-dino-prod \
KUBE_API_URL=http://127.0.0.1:8001 npm start
```

## Test

```bash
npm test
```

## Release

Push a tag like `v0.3.0`. CI runs the tests and publishes `ghcr.io/<owner>/kube-dino:0.3.0`.
