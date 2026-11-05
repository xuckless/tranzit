# Authentication — tranzit-db-middleware

This service authenticates **two classes of caller on two separate listeners**:

| Caller | Listener | Transport | Auth mechanism |
|---|---|---|---|
| End users (the mobile app) | public, behind Tailscale **Funnel** (`:8080` ← `:443`) | plain HTTP (Funnel terminates TLS) | **Supabase JWT** (`Authorization: Bearer` or `?token=`) |
| Sibling services (route-save, route-service) | **mTLS** listener (`MTLS_LISTEN_ADDR`, tailnet-only) | mutual TLS | **client certificate** issued by the private CA |

Why two listeners: Tailscale Funnel terminates TLS itself and strips any client
certificate, so X.509 mTLS can't ride the public port. The mTLS listener is a second
port bound inside the shared Tailscale netns; it is reachable at the node's tailnet
IP but is **not** Funnel-published, so it never carries end-user traffic.

Code: `auth.go` (JWT + request context), `mtls.go` (server TLS config), `main.go`
(`registerRoutes`, `buildVerifier`, `startMTLSListener`), `userdb.go` (ownership).

## Rollout — `AUTH_ENFORCE` (soft → hard)

Default is **soft** (`AUTH_ENFORCE=false`): credentials are verified and the result
logged, but requests are allowed through (JWT failures → treated as anonymous; the
mTLS listener uses `VerifyClientCertIfGiven`). This lets the frontend and siblings
roll out credentials without an outage.

Flip to **hard** (`AUTH_ENFORCE=true`, redeploy) once the logs are clean:
- Public listener: missing/invalid JWT → `401` (except `GET /health`).
- mTLS listener: `RequireAndVerifyClientCert` — no/invalid client cert → handshake rejected.
- User-data ownership (below) → enforced (`401`/`403`, or scoped to the owner).

## End-user JWT (public listener)

Supabase signs access tokens with **asymmetric ES256**; we verify them against the
project JWKS (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`) using
`golang-jwt/jwt/v5` + `MicahParks/keyfunc/v3` (keyfunc background-refreshes the keys,
so signing-key rotation needs no redeploy). Validated claims: `iss` =
`{SUPABASE_URL}/auth/v1`, `aud` = `authenticated`, `exp` (required). Identity is the
`sub` claim — the Supabase user UUID. Guests (anonymous sign-in) carry a valid token
with a real `sub`, so they authenticate normally. `GET /health` is always open.

## Per-user ownership (`/api/v1/user/*`)

The user-data tables are owned by a single user via the **`user_id`** column. End
users may only touch their own rows; this is enforced in `userdb.go`
(`scopeToOwner`, `enforceUpsertOwner`) over `userOwnedTables`:

```
user_info, user_defined_default_categories, user_defined_default_themes,
user_defined_events, cached_pre_routes, saved_addresses, user_themes,
user_history, user_calendar
```

- **GET / DELETE:** the `user_id` filter is forced to the token `sub` (overriding any
  client value) when enforcing.
- **POST upsert:** rows must carry the caller's `user_id` — absent ones are stamped,
  foreign ones rejected with `403`.
- **Service (mTLS) callers bypass** ownership entirely (trusted first-party).
- Inherently-shared tables (`posts`, `user_posts`, `user_friendships`) are **excluded**
  — they have no single owner. Revisit if/when they get per-row ACLs.

In soft mode these only **log** what they would block, so legitimate app traffic
(which already sends its own `user_id`) is unchanged before the flip.

## Service-to-service mTLS

A single private CA signs one leaf certificate per service (CN/SAN = service name,
both `serverAuth` + `clientAuth` EKU, so one identity covers calling and being
called). Callers present their cert; this service verifies it against the CA **and
pins** the leaf CN/SAN against `MTLS_ALLOWED_CLIENTS`
(`tranzit-route-save,tranzit-route-service`) — a CA-signed cert outside that list is
rejected. This service is mTLS **server only** (it calls no sibling).

### Generating / rotating certs

```bash
bash scripts/gen-mtls-certs.sh            # → ./certs-out/{ca,<svc>}.crt/.key
# distribute per repo (only its own leaf + the shared ca.crt):
cp certs-out/ca.crt certs-out/tranzit-db-middleware.crt certs-out/tranzit-db-middleware.key certs/
```

`certs/` is git-ignored and mounted read-only into the container (`./certs:/certs:ro`).
Rotate by re-running, redistributing, and redeploying. **Keep `ca.key` offline** —
it can mint a trusted service identity.

## Environment

| Var | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL for JWKS verification (required when enforcing) |
| `AUTH_ENFORCE` | `false` (soft, default) / `true` (hard 401/403 + RequireAndVerifyClientCert) |
| `MTLS_LISTEN_ADDR` | mTLS listener address, e.g. `:8443` (unset disables the S2S listener) |
| `MTLS_CA_CERT` / `MTLS_CERT` / `MTLS_KEY` | CA + this service's leaf (container paths) |
| `MTLS_ALLOWED_CLIENTS` | comma-separated client CNs allowed over mTLS |

## Verify

```bash
# JWT (public): health open; protected route 401 only once enforcing
curl -i $FUNNEL/health
curl -i "$FUNNEL/api/v1/calgary_transit_stops?limit=1"            # 401 when enforced, no token
curl -i -H "Authorization: Bearer $JWT" "$FUNNEL/api/v1/calgary_transit_stops?limit=1"

# Ownership: as user A, query/delete another user's rows → scoped to A / nothing deleted (enforced)
curl -i -H "Authorization: Bearer $JWT_A" "$FUNNEL/api/v1/user/saved_addresses?user_id=$UID_B"

# mTLS (service listener, over the tailnet):
curl --cacert certs/ca.crt --cert certs/tranzit-route-save.crt --key certs/tranzit-route-save.key \
     "https://<tailnet-ip>:8443/api/v1/trip_stops?trip_id=…"      # 200
curl --cacert certs/ca.crt "https://<tailnet-ip>:8443/api/v1/trip_stops?trip_id=…"  # rejected when enforced
```
