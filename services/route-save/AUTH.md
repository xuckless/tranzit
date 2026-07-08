# Authentication — tranzit-route-save

Route Save sits on both sides of the Tranzit auth model:

| Direction | Mechanism |
|---|---|
| **Inbound** — the mobile app calls `/trips`, `/trips/{id}`, the trip WS, etc. | **Supabase JWT**, hard-enforced (`Authorization: Bearer`, or `?token=` for the WS) |
| **Outbound** — Route Save calls tranzit-db-middleware and tranzit-route-service | **mutual TLS** with a private-CA client cert (Route Save is a client only; nothing calls it service-to-service) |

## Inbound — Supabase JWT (phase 1, enforced)

Every endpoint except `GET /health` requires a valid Supabase access token (ES256,
verified against the project JWKS; claims `iss`/`aud=authenticated`/`exp`). Identity
is the token `sub` (the Supabase user UUID); guests carry a valid token too. The trip
owner is bound at creation from the verified `sub` (never a client field) and
per-trip ownership is enforced: non-owners get `404` on GET/WS, idempotent `204` on
DELETE. Code: `internal/auth` (`JWKSVerifier`, `RequireAuth`), wired in
`internal/api/http.go`. This is **hard-enforced** — the app already attaches the
token. Requires `SUPABASE_URL`.

## Outbound — service-to-service mTLS (phase 2)

Route Save's calls to its siblings present a client certificate issued by the shared
private CA and verify the sibling's server cert against that CA. The CA + per-service
certs come from the **middleware** repo's `scripts/gen-mtls-certs.sh`; copy `ca.crt` +
this service's leaf (`tranzit-route-save.crt/.key`) into `certs/` (git-ignored,
mounted `./certs:/certs:ro`). Helper: `internal/mtls`.

Per sibling, calls use mTLS over the tailnet when its `*_MTLS_ADDR` is set, and fall
back to the public Funnel URL otherwise (so this can deploy before the siblings'
mTLS listeners exist). The dial targets `https://$ADDR`; verification uses
`ServerName` (the sibling's cert SAN), so the address can be a bare tailnet IP.
Wiring: `siblingTransport()` in `main.go` swaps the transport on the existing
datasource / rtfeed / routeclient HTTP clients.

> **Warning:** the Funnel fallback sends **no credential at all** — no client cert and
> no JWT — so sibling calls over the public Funnel URL are anonymous. This works only
> while the siblings run with soft auth (`AUTH_ENFORCE=false`). Before flipping
> `AUTH_ENFORCE=true` on tranzit-route-service (or the middleware), set the
> corresponding `*_MTLS_ADDR` here so calls go over mTLS, or those calls will start
> failing with 401s.

| Var | Purpose |
|---|---|
| `MTLS_CA_CERT` / `MTLS_CERT` / `MTLS_KEY` | CA + this service's leaf (container paths) |
| `MIDDLEWARE_MTLS_ADDR` / `ROUTE_SERVICE_MTLS_ADDR` | sibling tailnet `host:port`; empty → Funnel fallback |
| `MIDDLEWARE_MTLS_SERVERNAME` / `ROUTE_SERVICE_MTLS_SERVERNAME` | SAN to verify (defaults = service names) |

See each sibling's `AUTH.md` for the server side. Verify with `curl --cacert ca.crt
--cert tranzit-route-save.crt --key tranzit-route-save.key https://<tailnet-ip>:8443/…`.
