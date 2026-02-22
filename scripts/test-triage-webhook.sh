#!/usr/bin/env bash
#
# Test the Pylon webhook triage endpoint locally.
#
# Usage:
#   ./scripts/test-triage-webhook.sh
#
# Requires:
#   - Server running (pnpm run dev)
#   - .env with PYLON_WEBHOOK_SECRET set
#
# Override defaults with env vars:
#   PORT=3000 PYLON_WEBHOOK_SECRET=mysecret ./scripts/test-triage-webhook.sh

set -euo pipefail

# load .env if present
if [[ -f .env ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' .env | xargs)
fi

PORT="${WEBHOOK_PORT:-3000}"
SECRET="${PYLON_WEBHOOK_SECRET:?Set PYLON_WEBHOOK_SECRET in .env or environment}"

PAYLOAD=$(cat <<'JSON'
{
  "data": {
    "id": "test_issue_001",
    "title": "configuration issue",
    "body_html": "<p>we're seeing an issue with fern docs where the api reference has too many folders. we want the top level to be flattened. is there a setting for that?</p>",
    "state": "new",
    "link": "https://app.usepylon.com/issues/test_issue_001",
    "account": {
      "id": "acc_test",
      "name": "Test Company (local webhook test)"
    },
    "requester": {
      "email": "test@example.com"
    },
    "attachment_urls": []
  }
}
JSON
)

TIMESTAMP=$(date +%s)
SIGNATURE=$(printf '%s' "${TIMESTAMP}.${PAYLOAD}" | openssl dgst -sha256 -hmac "${SECRET}" | awk '{print $NF}')

echo "=== Triage webhook test ==="
echo "URL:       http://localhost:${PORT}/pylon/webhook"
echo "Timestamp: ${TIMESTAMP}"
echo "Signature: ${SIGNATURE}"
echo ""

HTTP_CODE=$(curl -s -o /tmp/triage-response.json -w "%{http_code}" \
  -X POST "http://localhost:${PORT}/pylon/webhook" \
  -H "Content-Type: application/json" \
  -H "pylon-webhook-signature: ${SIGNATURE}" \
  -H "pylon-webhook-timestamp: ${TIMESTAMP}" \
  -d "${PAYLOAD}")

echo "HTTP ${HTTP_CODE}"
cat /tmp/triage-response.json
echo ""

if [[ "${HTTP_CODE}" == "200" ]]; then
  echo "Webhook accepted! Check your server logs and Slack for the triage message."
else
  echo "Webhook rejected. Check the server logs for details."
fi
