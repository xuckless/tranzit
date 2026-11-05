// Service endpoints.
//
// Every URL here comes from the environment, so no deployment detail is baked
// into the source tree. Copy `.env.example` to `.env.local` and fill these in
// — see the "Run it yourself" section of the repository README.
//
// Expo inlines `EXPO_PUBLIC_*` at bundle time, which only works for static
// property accesses on `process.env`. That is why each variable is spelled out
// below instead of being read from a map.

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is not set. Copy apps/mobile/.env.example to .env.local and fill it in.`,
    );
  }
  // Tolerate a trailing slash in the configured value.
  return value.replace(/\/+$/, "");
}

/** Point the app at a Route Service running on localhost instead of a deployment. */
const USE_LOCAL = process.env.EXPO_PUBLIC_USE_LOCAL === "true";

/** Route Service — journey planning, place search, autocomplete. */
export const ROUTE_SERVICE_URL = USE_LOCAL
  ? "http://localhost:3100"
  : required(
      "EXPO_PUBLIC_ROUTE_SERVICE_URL",
      process.env.EXPO_PUBLIC_ROUTE_SERVICE_URL,
    );

/** Route Save — WebSocket + REST for active trip sessions. */
export const ROUTE_SAVE_URL = required(
  "EXPO_PUBLIC_ROUTE_SAVE_URL",
  process.env.EXPO_PUBLIC_ROUTE_SAVE_URL,
);

/** DB Middleware — authenticated table reads and the realtime SSE streams. */
export const MIDDLEWARE_URL = required(
  "EXPO_PUBLIC_MIDDLEWARE_URL",
  process.env.EXPO_PUBLIC_MIDDLEWARE_URL,
);

/** Live vehicle position stream (Server-Sent Events). */
export const VEHICLE_SSE_URL = `${MIDDLEWARE_URL}/api/v1/vehicle_positions`;
