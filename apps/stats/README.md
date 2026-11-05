# apps/stats — Tranzit operator dashboard

A read-only Nuxt dashboard for the Tranzit services: container resource usage, private-mesh
peer state, and a health panel that tells you whether each service is actually **serving** —
not merely `Up`.

See [`CONTEXT.md`](CONTEXT.md) for the detailed architecture.

## Why "serving" and not "Up"

The interesting failure mode in this deployment is **netns desync**. Each service shares a
network namespace with a Tailscale sidecar (`network_mode: service:tailscale`). If the sidecar
restarts, the app is left listening in the orphaned old namespace: `docker ps` reports the
container healthy, and every request through the tunnel returns 502.

So `/api/health` probes each service **server-side over its real URL** rather than asking Docker.
That also sidesteps browser CORS against the tunnel hosts. `POST /api/restart` is the manual fix —
restarting the *app* container re-attaches it to the sidecar's current namespace.

The `*-ts` sidecars are deliberately **not** restartable from here: restarting a sidecar is what
causes the desync in the first place.

## API

| Route | What it does |
|---|---|
| `GET /api/docker` | `docker stats --no-stream` — CPU, memory, network I/O per container |
| `GET /api/tailscale` | `tailscale status --json` — peers, addresses, Rx/Tx |
| `GET /api/health` | Server-side probe of each service; Postgres is checked via `docker inspect` |
| `POST /api/restart` | `docker restart <container>`, container name checked against a whitelist |

`server/utils/services.ts` is the single source of truth for the service list, the probe URLs and
the restart whitelist. **Point it at your own deployment before running this** — the committed
hostnames are placeholders.

Both listing endpoints filter to names containing `tranzit` (case-insensitive), so unrelated local
containers and personal devices on the mesh never appear.

## Safety notes

- `/api/restart` runs `execFile` with no shell, and only for a name on `RESTART_WHITELIST`.
- This dashboard shells out to `docker` and `tailscale` on its host. It is an **operator tool** —
  run it on a trusted host, bound to localhost. It has no authentication of its own.

## Run

```bash
npm install
npm run dev      # http://localhost:3000
```

Polling: docker stats every 2s, mesh status every 5s, service health every 10s. Charts keep a
rolling 30-point window in memory.

## Build

```bash
npm run build && npm run preview
```
