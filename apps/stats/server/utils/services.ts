/**
 * Single source of truth for the Tranzit microservices the dashboard tracks.
 *
 * Used by:
 *  - /api/health  — probes each service to see if it is actually *serving*.
 *  - /api/restart — the `container` values here are the restart whitelist; an
 *                   incoming restart request is rejected unless its container
 *                   name matches one of these exactly.
 *
 * All app containers are pinned to a `*-ts` Tailscale sidecar via
 * `network_mode: container:<sidecar>`. NEVER restart the sidecars from here —
 * restarting a sidecar is what *causes* the netns desync (the pinned app keeps
 * listening in the orphaned old namespace and the Funnel 502s).
 */

export type ServiceKind = 'http' | 'docker'

export interface ServiceDef {
  /** Stable id used by the UI. */
  key: string
  /** Human label. */
  label: string
  /** Docker container name — doubles as the restart whitelist entry. */
  container: string
  /** `http` → probe `url`; `docker` → read container health via `docker inspect`. */
  kind: ServiceKind
  /** Public Funnel health-probe URL (http services only). */
  url?: string
  /** HTTP statuses considered healthy. Defaults to [200]. */
  okStatuses?: number[]
}

// TRANZIT_DEMO=1 (set by ./demo.sh up --stats) probes the local Docker Compose
// demo stack on localhost instead of the Funnel hostnames.
const DEMO = process.env.TRANZIT_DEMO === '1'
const DEMO_PORTS: Record<string, number> = {
  'tranzit-route-service': 3100,
  'tranzit-db-middleware': 8080,
  'tranzit-route-save': 8090,
  'tranzit-otp': 8888,
  'tranzit-rt-service': 8765,
}
const FUNNEL = (host: string) =>
  DEMO ? `http://localhost:${DEMO_PORTS[host]}` : `https://${host}.tailnet-example.ts.net`
/** Demo containers are prefixed `tranzit-demo-` so they never collide with a real deployment. */
const C = (name: string) => (DEMO ? name.replace(/^tranzit-/, 'tranzit-demo-') : name)

export const SERVICES: ServiceDef[] = [
  {
    key: 'route-service',
    label: 'Route Service',
    container: C('tranzit-route-service'),
    kind: 'http',
    url: `${FUNNEL('tranzit-route-service')}/limits`,
  },
  {
    key: 'db-middleware',
    label: 'DB Middleware',
    container: C('tranzit-db-middleware'),
    kind: 'http',
    url: `${FUNNEL('tranzit-db-middleware')}/health`,
  },
  {
    key: 'route-save',
    label: 'Route Save',
    container: C('tranzit-route-save'),
    kind: 'http',
    url: `${FUNNEL('tranzit-route-save')}/health`,
  },
  {
    key: 'otp',
    label: 'OpenTripPlanner',
    container: C('tranzit-otp'),
    kind: 'http',
    url: `${FUNNEL('tranzit-otp')}/`,
  },
  {
    key: 'rt-service',
    label: 'RT Service',
    container: C('tranzit-rt-service'),
    kind: 'http',
    url: `${FUNNEL('tranzit-rt-service')}/gtfs-rt/trip-updates`,
  },
  {
    key: 'user-db',
    label: DEMO ? 'Postgres (GTFS + user data)' : 'User DB (Postgres)',
    container: DEMO ? 'tranzit-demo-postgres' : 'tranzit-user-db',
    kind: 'docker',
  },
]

/** The set of container names that /api/restart is allowed to touch. */
export const RESTART_WHITELIST = new Set(SERVICES.map((s) => s.container))
