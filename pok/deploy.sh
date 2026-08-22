#!/usr/bin/env bash
#
# Deploys the payments service (card via Pok, crypto via NowPayments) on the
# server that already hosts the site. Run it ON the box, from this folder:
#
#   cd /path/to/ag-web-visionfx/pok
#   POK_KEY_ID=... POK_KEY_SECRET=... POK_MERCHANT_ID=... \
#   NOWPAYMENTS_API_KEY=... NOWPAYMENTS_IPN_SECRET=... \
#   ./deploy.sh
#
# What it does: builds the image, runs it bound to 127.0.0.1:3000, waits for
# /health, and then tells you the one routing change still needed.
#
# What it does NOT do: touch the site, its container, nginx, or Traefik.
# Nothing here can take the site down — the worst case is the payments
# container fails to start and the checkout keeps falling back to PayPal.

set -euo pipefail

NAME=visionfx-pok
PORT=3000
BIND=127.0.0.1

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '  \033[33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\n\033[31mstopped:\033[0m %s\n' "$*" >&2; exit 1; }

say "1/6  preflight"
[ -f server.js ] && [ -f Dockerfile ] || die "run this from the repo's pok/ folder"
command -v docker >/dev/null || die "docker not found"
docker info >/dev/null 2>&1 || die "cannot talk to docker — are you root?"
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"

missing=()
for v in POK_KEY_ID POK_KEY_SECRET POK_MERCHANT_ID; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
[ ${#missing[@]} -eq 0 ] || die "missing required env: ${missing[*]}"
ok "Pok credentials present"

if [ -n "${NOWPAYMENTS_API_KEY:-}" ]; then
  ok "NowPayments key present — crypto will be enabled"
  [ -n "${NOWPAYMENTS_IPN_SECRET:-}" ] || warn "NOWPAYMENTS_IPN_SECRET not set — IPN callbacks will all be rejected"
else
  warn "NOWPAYMENTS_API_KEY not set — crypto stays off, card still works"
fi

ORIGIN="${ALLOWED_ORIGINS:-https://anduelgega.com}"
ok "allowed origin: $ORIGIN"

say "2/6  build image"
docker build -q -t "$NAME:latest" . >/dev/null
ok "built $NAME:latest"

say "3/6  replace any previous container"
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  docker rm -f "$NAME" >/dev/null
  ok "removed the old $NAME"
else
  ok "no previous container"
fi

say "4/6  start"
# Bound to loopback on purpose: the service is reached through the site's
# proxy, so it is never exposed directly to the internet.
docker run -d --name "$NAME" --restart unless-stopped \
  -p "$BIND:$PORT:3000" \
  -e POK_KEY_ID -e POK_KEY_SECRET -e POK_MERCHANT_ID \
  -e POK_ENV="${POK_ENV:-production}" \
  -e ALLOWED_ORIGINS="$ORIGIN" \
  ${NOWPAYMENTS_API_KEY:+-e NOWPAYMENTS_API_KEY} \
  ${NOWPAYMENTS_IPN_SECRET:+-e NOWPAYMENTS_IPN_SECRET} \
  ${NOWPAYMENTS_IPN_URL:+-e NOWPAYMENTS_IPN_URL} \
  ${NOWPAYMENTS_SUCCESS_URL:+-e NOWPAYMENTS_SUCCESS_URL} \
  "$NAME:latest" >/dev/null
ok "container started on $BIND:$PORT"

say "5/6  wait for health"
health=''
for i in $(seq 1 20); do
  health=$(curl -fsS --max-time 3 "http://$BIND:$PORT/health" 2>/dev/null || true)
  [ -n "$health" ] && break
  sleep 1
done
if [ -z "$health" ]; then
  warn "no response after 20s — last 30 log lines:"
  docker logs --tail 30 "$NAME" 2>&1 | sed 's/^/      /'
  die "service did not come up (the site and PayPal are unaffected)"
fi
ok "health: $health"
case "$health" in
  *'"crypto":true'*)  ok "crypto enabled" ;;
  *)                  warn "crypto disabled — set NOWPAYMENTS_API_KEY and re-run" ;;
esac

say "6/6  what's left: routing"
cat <<'ROUTE'
  The container answers on 127.0.0.1:3000 but the browser reaches it at
  https://anduelgega.com/api/... , so the site's proxy needs to forward two
  paths. In the nginx that serves the site, inside its server block:

      location ^~ /api/pok/         { proxy_pass http://127.0.0.1:3000; }
      location ^~ /api/nowpayments/ { proxy_pass http://127.0.0.1:3000; }
      location = /health            { proxy_pass http://127.0.0.1:3000; }

  Then:  nginx -t && systemctl reload nginx      (reload, not restart)

  Worth adding while you are in there — HTML is served with no Cache-Control,
  which is why deployed changes keep looking unshipped:

      location ~* \.html$ { add_header Cache-Control "no-cache, must-revalidate"; }

  Verify from anywhere once routing is live:

      curl https://anduelgega.com/health
      # {"ok":true,...,"providers":{"card":true,"crypto":true}}

  The card and crypto buttons switch themselves on as soon as that answers.
  No site redeploy needed.
ROUTE

say "detected on this host"
if docker ps --format '{{.Names}} {{.Image}}' | grep -qiE 'traefik|coolify-proxy'; then
  docker ps --format '  {{.Names}}  ({{.Image}})' | grep -iE 'traefik|coolify-proxy' || true
  echo "  → proxy looks like Traefik/Coolify: add the route in the Coolify UI"
  echo "    (or as labels) rather than editing nginx by hand."
fi
if [ -d /etc/nginx ]; then
  echo "  /etc/nginx exists — host nginx config:"
  ls /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* 2>/dev/null | sed 's/^/    /' | head -10
fi
echo
echo "  logs:    docker logs -f $NAME"
echo "  restart: docker restart $NAME"
