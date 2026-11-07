#!/bin/bash
# First-boot only (empty pgdata volume): create the user-data database, apply the
# real schema from infra/user-db, then the demo seed.
set -euo pipefail
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE tranzit_user OWNER $POSTGRES_USER"
for f in /schema/initdb/*.sql; do
  echo "applying $f"
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d tranzit_user -f "$f"
done
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d tranzit_user -v demo_user="$DEMO_USER_ID" -f /schema/seed.sql
