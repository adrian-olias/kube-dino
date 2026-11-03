# kube-dino

API behind the Kube Dino panel on the [portfolio](https://github.com/adrian-olias/portfolio).
It lists the app's pods and can evict one, so visitors can watch Kubernetes bring it back.

Plain Node.js with no dependencies, running on a distroless image.

## Endpoints

| Route | What it does |
|---|---|
| `GET /api/cluster` | Pods of the app, plus CPU and memory usage |
| `POST /api/chaos` | Evicts one pod |
| `GET /healthz` | Health check |

## Run locally

```bash
cp .env.example .env
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

