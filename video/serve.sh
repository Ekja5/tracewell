#!/usr/bin/env bash
# Starts the app for recording on port 3210 against the dedicated demo database.
cd "$(dirname "$0")/.."
export DATABASE_URL=postgres://orthoapp:orthoapp_local_only@127.0.0.1:5433/tracewell_video PORT=3210 NODE_ENV=development DEMO_LOGIN_SHORTCUTS=true DEMO_CLOCK=true ASSISTANT_MODE=${ASSISTANT_MODE:-demo} ACCESS_LOG=off SESSION_SECRET=video-demo-local-only-0123456789abcdef
exec npx tsx src/server/index.ts
