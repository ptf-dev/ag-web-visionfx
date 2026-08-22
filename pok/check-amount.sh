#!/usr/bin/env bash
#
# Settles the one open question in the Pok integration: does the API take
# euros or cents?
#
# Creates a single order for amount=1 and reads it straight back. An SDK order
# that nobody pays moves no money and simply expires, so this is safe to run
# against production.
#
#   POK_KEY_ID=... POK_KEY_SECRET=... POK_MERCHANT_ID=... ./check-amount.sh
#
# Defaults to production because the keys the dashboard issues are production
# keys. Override with POK_ENV=staging if POK support has given you staging ones.

set -euo pipefail

: "${POK_KEY_ID:?set POK_KEY_ID}"
: "${POK_KEY_SECRET:?set POK_KEY_SECRET}"
: "${POK_MERCHANT_ID:?set POK_MERCHANT_ID}"

if [ "${POK_ENV:-production}" = "staging" ]; then
  BASE="https://api-staging.pokpay.io"
else
  BASE="https://api.pokpay.io"
fi

# jq is nicer but not everywhere; fall back to python3.
pick() {
  if command -v jq >/dev/null 2>&1; then jq -r "$1"
  else python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d$2') or '')" 2>/dev/null || echo ''
  fi
}

echo "→ $BASE"
echo

echo "1/3  login"
LOGIN=$(curl -sS -X POST "$BASE/auth/sdk/login" \
  -H 'Content-Type: application/json' \
  -d "{\"keyId\":\"$POK_KEY_ID\",\"keySecret\":\"$POK_KEY_SECRET\"}")

TOKEN=$(printf '%s' "$LOGIN" | pick '.data.accessToken' "['data']['accessToken']")
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "     failed:"; printf '%s\n' "$LOGIN"
  echo
  echo "     400 here usually means the wrong environment — production keys"
  echo "     only work on api.pokpay.io, staging keys only on api-staging."
  exit 1
fi
echo "     ok"

echo "2/3  create order for amount=1"
CREATED=$(curl -sS -X POST "$BASE/merchants/$POK_MERCHANT_ID/sdk-orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"amount":1,"currencyCode":"EUR","autoCapture":true,"shippingCost":0}')

ORDER_ID=$(printf '%s' "$CREATED" | pick '.data.sdkOrder.id // .data.id' "['data'].get('sdkOrder',{}).get('id') or d['data'].get('id')")
if [ -z "$ORDER_ID" ] || [ "$ORDER_ID" = "null" ]; then
  echo "     failed:"; printf '%s\n' "$CREATED"
  echo
  echo "     403 here means POK_MERCHANT_ID does not belong to this key pair."
  exit 1
fi
echo "     order $ORDER_ID"

echo "3/3  read it back"
curl -sS "$BASE/sdk-orders/$ORDER_ID" -H "Authorization: Bearer $TOKEN" \
  | { if command -v jq >/dev/null 2>&1; then jq .; else cat; echo; fi; }

cat <<EOF

────────────────────────────────────────────────────────────
Now open this order in POK Business → Pagesat online.

  shows €1.00   → major units. Leave AMOUNT_IN_MINOR_UNITS = false
  shows €0.01   → minor units. Set  AMOUNT_IN_MINOR_UNITS = true

Both in pok/worker.js. Getting it wrong charges €3.50 or €35,000
instead of €350, so read it off the dashboard rather than guessing.
────────────────────────────────────────────────────────────
EOF
