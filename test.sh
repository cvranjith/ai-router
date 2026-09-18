#!/bin/bash
# One curl per service ID. Usage:
#   WORKER_URL=https://ai-router.<subdomain>.workers.dev GATEWAY_TOKEN=... ./test.sh
set -euo pipefail

WORKER_URL="${WORKER_URL:?Set WORKER_URL to your deployed Worker's URL}"
GATEWAY_TOKEN="${GATEWAY_TOKEN:?Set GATEWAY_TOKEN to the shared token you put via 'wrangler secret put GATEWAY_TOKEN'}"

echo "--- local.codex (missing token, expect 401) ---"
curl -s -o /dev/null -w "http_code=%{http_code}\n" -X POST "$WORKER_URL/v1/invoke" \
  -H 'Content-Type: application/json' \
  -d '{"service":"local.codex","input":"jNQXAC9IVRw"}'

echo "--- local.codex (unknown service, expect 400) ---"
curl -s -X POST "$WORKER_URL/v1/invoke" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"service":"nope"}'
echo

echo "--- local.codex (real call) ---"
curl -s -X POST "$WORKER_URL/v1/invoke" \
  -H "Authorization: Bearer $GATEWAY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"service":"local.codex","input":"jNQXAC9IVRw","options":{"length":"short"}}'
echo
