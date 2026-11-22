#!/usr/bin/env bash
# Rebuild the demo account (and restart the recording server so nothing is cached).
cd "$(dirname "$0")/.."
pkill -f "tsx src/server/index.ts" 2>/dev/null; sleep 1
DATABASE_URL=postgres://orthoapp:orthoapp_local_only@127.0.0.1:5433/tracewell_video npx tsx video/seed-demo.ts "$@" 2>&1 | grep -v migrate
(nohup video/serve.sh > /tmp/claude-0/video-srv.log 2>&1 &)
for i in $(seq 1 30); do curl -sf http://127.0.0.1:3210/api/health >/dev/null && break; sleep 1; done
