#!/usr/bin/env bash
# Starts a local PostgreSQL 16 for development if DATABASE_URL is not already reachable.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
set -a; source .env; set +a
if pg_isready -d "$DATABASE_URL" -q 2>/dev/null && psql "$DATABASE_URL" -qtAc 'select 1' >/dev/null 2>&1; then
  echo "[db] reachable at DATABASE_URL"; exit 0; fi
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  echo "[db] starting docker compose postgres"; docker compose up -d db
  for i in $(seq 1 30); do pg_isready -h 127.0.0.1 -p 5433 -q && break; sleep 1; done; exit 0; fi
PGBIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)
[ -n "$PGBIN" ] || PGBIN=$(dirname "$(command -v pg_ctl)")
DATA="$PWD/.pgdata"; PORT="${PGPORT_LOCAL:-5433}"
RUNAS=""; if [ "$(id -u)" = "0" ]; then RUNAS="runuser -u postgres --"; fi
if [ ! -f "$DATA/PG_VERSION" ]; then
  mkdir -p "$DATA"; [ -n "$RUNAS" ] && chown postgres "$DATA"
  $RUNAS "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 >/dev/null
fi
if ! pg_isready -h 127.0.0.1 -p "$PORT" -q; then
  $RUNAS "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$DATA/server.log" -w start >/dev/null
fi
psql -h 127.0.0.1 -p "$PORT" -U postgres -qtAc "select 1 from pg_roles where rolname='orthoapp'" | grep -q 1 || \
  psql -h 127.0.0.1 -p "$PORT" -U postgres -qc "CREATE ROLE orthoapp LOGIN PASSWORD 'orthoapp_local_only' NOSUPERUSER NOBYPASSRLS"
for db in tracewell tracewell_test; do
  psql -h 127.0.0.1 -p "$PORT" -U postgres -qtAc "select 1 from pg_database where datname='$db'" | grep -q 1 || \
    psql -h 127.0.0.1 -p "$PORT" -U postgres -qc "CREATE DATABASE $db OWNER orthoapp"
done
echo "[db] local postgres ready on 127.0.0.1:$PORT"
