# Tranzit Stats Dashboard

This is a Nuxt 3 application that serves as a read-only dashboard to monitor the status of the local Tranzit microservices and their Tailscale network endpoints.

## Architecture

- **Frontend:** Nuxt 3, Vue 3, Tailwind CSS for styling, and Chart.js (`vue-chartjs`) for real-time graphs.
- **Backend (Nitro API):**
  - `/api/docker`: Executes `docker stats --no-stream --format "{{json .}}"` to get current container resource usage (CPU, Memory, Network I/O).
  - `/api/tailscale`: Executes `tailscale status --json` to get the list of active peers, their IPs, and Rx/Tx bytes.
  - `/api/health`: Probes each Tranzit service to confirm it is actually *serving* (not just "Up"). HTTP services are fetched server-side over their public Funnel URL (`https://*.tailnet-example.ts.net`, defined in `server/utils/services.ts`); `tranzit-user-db` (Postgres, no HTTP) is checked via `docker inspect` health state. Server-side fetch avoids browser CORS against the Funnel hosts and catches the **netns-desync 502** class (sidecar restarted → app left listening in the orphaned old netns → Funnel 502 even though `docker ps` says "Up").
  - `/api/restart` (POST `{ container }`): Runs `docker restart <container>` — the manual fix for netns desync (re-attaches the app to its sidecar's current network namespace). The container name is validated against the `RESTART_WHITELIST` in `server/utils/services.ts` and run via `execFile` (no shell) to prevent injection. The `*-ts` Tailscale sidecars are intentionally **not** restartable here — restarting a sidecar is what causes desync.

`server/utils/services.ts` is the single source of truth: the service list, their health-probe URLs, and the restart whitelist.

## Filtering Logic (CRITICAL)
Both API endpoints apply a strict text filter. They *only* return containers or Tailscale peers where the Name/HostName contains the word `"tranzit"` (case-insensitive). This ensures the dashboard only tracks the relevant project infrastructure and ignores unrelated local containers or personal devices on the Tailscale network.

## Polling Strategy
The client `app.vue` implements a JavaScript `setInterval` loop:
- Docker stats are fetched every **2 seconds**.
- Tailscale stats are fetched every **5 seconds**.
- Service health (`components/HealthPanel.vue`) is polled every **10 seconds**.

The charts hold a rolling window of the last 30 data points in memory to display a live history of CPU and Memory usage.

## Development
Run the dev server using `npm run dev`. The dashboard will be available at `http://localhost:3000`.