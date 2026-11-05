# tranzit-user-db

A Postgres server running in Docker, joined to the tailnet via a Tailscale sidecar — the same
deployment pattern as the other Tranzit projects, but **private**.

Postgres speaks raw TCP, which doesn't fit Tailscale Funnel's HTTPS/SNI model, so this node is
**not** exposed to the public internet. Instead the DB sits privately on the tailnet, and the
already-public `tranzit-db-middleware` is the only internet-facing surface:

```
Internet ──HTTPS Funnel:443──▶ tranzit-db-middleware (public)
                                      │  raw Postgres over the tailnet (WireGuard-encrypted)
                                      ▼
                              tranzit-user-db:5432   ◀── PRIVATE, never on the internet
```

The tailscale sidecar owns the network namespace and Postgres shares it
(`network_mode: service:tailscale`, `TS_USERSPACE=false`), so Postgres' `:5432` is reachable at
the node's tailnet address from any peer. `:5432` is also published to `127.0.0.1` for local use.

## Run

```bash
# Optional: put a reusable auth key in .env (else you log in via a printed URL)
cp .env.example .env   # then set TS_AUTHKEY=tskey-auth-...  (POSTGRES_PASSWORD is prefilled)

docker compose up -d
# If no TS_AUTHKEY: grab the login URL and click it to authorize the node
docker compose logs -f tailscale   # look for https://login.tailscale.com/a/...
```

Once authorized, the node `tranzit-user-db` appears in the Tailscale admin console.

## Connect

- **Local:** `postgres://tranzit-user:change-me@127.0.0.1:5432/tranzit-user`
- **Tailnet:** `postgres://tranzit-user:change-me@tranzit-user-db.tailnet-example.ts.net:5432/tranzit-user?sslmode=disable`

Verify:

```bash
docker compose ps                                   # both containers up, postgres healthy
docker exec -it tranzit-user-db psql -U tranzit-user -d tranzit-user -c '\l'
psql "postgres://tranzit-user:change-me@127.0.0.1:5432/tranzit-user" -c "select version();"
```

Full credentials live in `CREDENTIALS.md` (gitignored).

## Schema

The user-data schema (12 tables) lives in `schema.sql`. It is also copied to
`initdb/01-schema.sql`, which the postgres image auto-runs **only on a fresh volume**. To apply
it to an already-running DB:

```bash
docker exec -i tranzit-user-db psql -U tranzit-user -d tranzit-user -v ON_ERROR_STOP=1 < schema.sql
```

## Notes

- Data persists in the `pgdata` named volume; the tailnet identity persists in `tailscale-state`.
- No `ts-serve.json` / Funnel config — that exists only for the Funnel'd HTTP services.
- To wire the middleware to this DB later, set its `SUPABASE_DIRECT_CONNECTION_STRING` to the
  tailnet DSN above (see `CREDENTIALS.md`).
```
