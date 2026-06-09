# tranzit-otp

Self-hosted **OpenTripPlanner 2** routing engine for Calgary — walk / bike / transit.
Replaces Google Routes as the backend for `tranzit-route-service`'s `/route/otp` endpoint.

## What it does

- Builds a routing graph from **Calgary's static GTFS** (`npk7-z3bj`, `CT_GTFS.zip`) +
  an **OSM street network** clipped to the Calgary bbox.
- Streams the **three Calgary GTFS-RT feeds** (trip updates, vehicle positions, alerts)
  live via OTP's realtime updaters (`router-config.json`) — delays/cancellations apply to
  trip plans without rebuilding the graph.
- Serves the GTFS GraphQL API at `http://<host>:8080/otp/routers/default/index/graphql`.

## Prerequisites

- Java 21+
- [`osmium-tool`](https://osmcode.org/osmium-tool/) (for the OSM clip step in `build.sh`)
- ~4 GB RAM free for the graph build

## Build & run (local)

```bash
./build.sh     # fetch OTP jar + GTFS + Alberta OSM, clip to Calgary, build graph.obj
./run.sh       # serve on :8080
```

Then point the Go service at it:

```bash
# in tranzit-route-service/.env
OTP_BASE_URL=http://localhost:8080
```

Smoke test (downtown → University of Calgary, walk+transit):

```bash
curl -s http://localhost:3100/route/otp \
  -H 'content-type: application/json' \
  -d '{"origin":{"lat":51.0447,"lng":-114.0719},
       "destination":{"lat":51.0782,"lng":-114.1372},
       "mode":"walk_transit"}' | jq '.itineraries[0].legs[].mode'
```

## Files

| File | Purpose |
|------|---------|
| `build-config.json` | Graph build sources: OSM extract + GTFS feed (`feedId: CT`) |
| `router-config.json` | Routing defaults + 3 GTFS-RT updaters (feedId `CT`) |
| `build.sh` | One-shot graph build (fetch, clip, `--build`) |
| `run.sh` | Serve the built graph (`--load`) |
| `Dockerfile` | Bakes `graph.obj` into an image (no cold-start fetch) |

## Run in Docker + expose over Tailscale

`docker-compose.yml` runs OTP in a container and joins it to your tailnet as a dedicated
node **`tranzit-otp`** via a Tailscale sidecar. The sidecar owns the network namespace and
OTP shares it (`network_mode: service:tailscale`), so OTP's `:8080` is reachable at the
node's tailnet address from any peer. `:8080` is also published to `127.0.0.1` for local use.

```bash
# Optional: put a reusable auth key in .env (else you log in via a printed URL)
cp .env.example .env   # then set TS_AUTHKEY=tskey-auth-...

docker compose up -d --build
# If no TS_AUTHKEY: grab the login URL and click it to authorize the node
docker compose logs -f tailscale   # look for https://login.tailscale.com/a/...
```

Once authorized, OTP is reachable on the tailnet at:

- **MagicDNS:** `http://tranzit-otp.tailnet-example.ts.net:8080`
- **Tailscale IP:** `http://<100.x.y.z>:8080`
- **Local:** `http://127.0.0.1:8080`

GraphQL: `…:8080/otp/routers/default/index/graphql`. Verify:

```bash
curl -s http://tranzit-otp.tailnet-example.ts.net:8080/otp/routers/default | head
```

### Making it discoverable from Cloud Run

Cloud Run reaches a private tailnet node only if the Cloud Run service is **also on the
tailnet**. The route-service container therefore needs its own Tailscale userspace sidecar:

1. Generate a **reusable, ephemeral** auth key (Tailscale admin → Settings → Keys).
2. In the route-service image, run `tailscaled --tun=userspace-networking --socks5-server=...`
   alongside the Go binary (entrypoint script does `tailscale up --authkey=$TS_AUTHKEY
   --hostname=tranzit-route-service` then `exec` the server).
3. Set the gateway's backend to the OTP node's MagicDNS name:
   `OTP_BASE_URL=http://tranzit-otp.tailnet-example.ts.net:8080`.
4. Deploy with `--no-cpu-throttling` (so `tailscaled` keeps the tunnel alive between requests)
   and the auth key in Secret Manager.

That sidecar image is **not built yet** (scoped out for now) — this section is the recipe for
when you wire it up. Alternative: `tailscale funnel 8080` exposes OTP over public HTTPS with no
Cloud Run sidecar, but makes the engine publicly reachable.

## Deployment notes

- OTP keeps the whole graph in memory (~2–4 GB) and has a multi-minute load time, so it is
  **not** suited to scale-to-zero. Run it on an **always-on VM** or Cloud Run with
  `min-instances=1`, `--memory=4Gi`, and `graph.obj` **baked into the image**.
- **Graph rebuild cadence:** static GTFS only changes when schedules change. Rebuild the
  graph (and redeploy the image) **weekly** via CI. Realtime is live via the updaters — no
  rebuild needed for delays.
- The updaters fetch directly from `data.calgary.ca`; no API token required.

## Modes

`tranzit-route-service` maps its `mode` field to OTP `transportModes`:

| API `mode` | OTP modes |
|------------|-----------|
| `walk` | WALK |
| `bike` | BICYCLE |
| `transit` / `walk_transit` (default) | WALK + TRANSIT |
| `bike_transit` | BICYCLE + TRANSIT |

CAR is never enabled — driving is intentionally unsupported.
