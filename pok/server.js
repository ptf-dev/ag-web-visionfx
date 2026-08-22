/**
 * Pok Payments order endpoint — plain Node, for Coolify.
 *
 * Same contract as worker.js (the Cloudflare variant); this is the version
 * that runs as a container next to the site. No npm dependencies — Node 18+
 * has fetch built in.
 *
 * Routes:
 *   GET  /health              readiness probe for Coolify
 *   POST /api/pok/order       create an order for the lifetime package
 *   GET  /api/pok/order/:id   read an order back (used to confirm payment)
 *   POST /api/pok/webhook     Pok calls this when an order changes state
 *
 * Required env: POK_KEY_ID, POK_KEY_SECRET, POK_MERCHANT_ID
 * Optional env: POK_ENV (default production), ALLOWED_ORIGINS, PORT,
 *               POK_WEBHOOK_URL, POK_REDIRECT_URL
 */

import { createServer } from 'node:http';

/**
 * The price is fixed here, on the server, on purpose. If the browser were
 * allowed to send an amount, anyone could open devtools and buy the package
 * for one euro.
 */
const PRICE_EUR = 350;

/**
 * Whether Pok's API wants euros or cents. Their docs show `"amount": 100`
 * with `"currencyCode": "EUR"` and never say which.
 *
 * Left at `false` deliberately: the two ways of being wrong are not equally
 * bad. At `false` a cents-based API would undercharge to EUR 3.50 — a loss,
 * caught on the first sale. At `true` a euro-based API would charge EUR
 * 35,000 to a real customer's card. So `false` is the fail-safe guess until
 * someone reads a real order in the dashboard (see pok/check-amount.sh).
 */
const AMOUNT_IN_MINOR_UNITS = false;

const PRODUCT = {
  amount: AMOUNT_IN_MINOR_UNITS ? PRICE_EUR * 100 : PRICE_EUR,
  currencyCode: 'EUR',
  label: 'Paketa Premium + Gold EA Vision — Lifetime',
};

const API = {
  staging: 'https://api-staging.pokpay.io',
  production: 'https://api.pokpay.io',
};
const BASE = API[process.env.POK_ENV === 'staging' ? 'staging' : 'production'];

const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/* ------------------------------------------------------------------ helpers */

function cors(req, res) {
  const origin = req.headers.origin || '';
  // Explicit origins only. A wildcard would let any site create orders
  // against this merchant account.
  if (ALLOWED.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Tokens are long-lived (production returned expiresIn 28800000, 8 hours).
// Reuse one rather than logging in on every checkout.
let cachedToken = null;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 30_000) return cachedToken.token;

  const res = await fetch(`${BASE}/auth/sdk/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keyId: process.env.POK_KEY_ID,
      keySecret: process.env.POK_KEY_SECRET,
    }),
  });
  // 400/401 here almost always means the wrong environment: production keys
  // only work on api.pokpay.io, staging keys only on api-staging.
  if (!res.ok) throw new Error(`pok login failed: ${res.status}`);

  const body = await res.json();
  const token = body?.data?.accessToken;
  if (!token) throw new Error('pok login returned no accessToken');

  cachedToken = { token, expiresAt: now + (Number(body?.data?.expiresIn) || 300_000) };
  return token;
}

/* ----------------------------------------------------------------- handlers */

async function createOrder(res) {
  const token = await getAccessToken();
  const r = await fetch(`${BASE}/merchants/${process.env.POK_MERCHANT_ID}/sdk-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      amount: PRODUCT.amount,
      currencyCode: PRODUCT.currencyCode,
      autoCapture: true,
      shippingCost: 0,
      ...(process.env.POK_WEBHOOK_URL ? { webhookUrl: process.env.POK_WEBHOOK_URL } : {}),
      ...(process.env.POK_REDIRECT_URL ? { redirectUrl: process.env.POK_REDIRECT_URL } : {}),
    }),
  });

  const body = await r.json().catch(() => null);
  if (!r.ok) {
    // 403 means merchantId does not belong to this key pair.
    console.error('pok create order failed', r.status, body?.message);
    return send(res, 502, { error: 'could_not_create_order' });
  }

  const orderId = body?.data?.sdkOrder?.id || body?.data?.id;
  if (!orderId) {
    console.error('pok create order returned no id');
    return send(res, 502, { error: 'could_not_create_order' });
  }

  // Only the order id crosses back to the browser.
  return send(res, 200, { orderId, amount: PRODUCT.amount, currency: PRODUCT.currencyCode });
}

async function readOrder(res, orderId) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(orderId)) return send(res, 400, { error: 'bad_order_id' });

  const token = await getAccessToken();
  const r = await fetch(`${BASE}/sdk-orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) return send(res, 404, { error: 'not_found' });

  const o = body?.data?.sdkOrder || body?.data || {};
  // Deliberately narrow: the page only needs to know whether it is paid.
  return send(res, 200, {
    id: o.id,
    status: o.status,
    amount: o.amount,
    capturedAmount: o.capturedAmount,
  });
}

/* -------------------------------------------------------------------- entry */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  cors(req, res);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (path === '/health') return send(res, 200, { ok: true, env: BASE });

  try {
    if (path === '/api/pok/order' && req.method === 'POST') return await createOrder(res);

    const m = path.match(/^\/api\/pok\/order\/([^/]+)$/);
    if (m && req.method === 'GET') return await readOrder(res, m[1]);

    if (path === '/api/pok/webhook' && req.method === 'POST') {
      // Anyone can POST here, so treat the body as a hint, never as proof of
      // payment. Re-read the order from the API before acting on it.
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const b = (() => { try { return JSON.parse(raw); } catch { return null; } })();
      console.log('pok webhook', JSON.stringify({
        orderId: b?.sdkOrderId || b?.data?.sdkOrder?.id || b?.id,
        status: b?.status,
      }));
      // Fulfilment goes here once licence delivery is decided.
      res.writeHead(200); return res.end('ok');
    }

    return send(res, 404, { error: 'not_found' });
  } catch (err) {
    // Log the detail, return none of it — Pok's error messages can leak
    // implementation detail.
    console.error('pok server error', err?.message);
    return send(res, 500, { error: 'server_error' });
  }
});

for (const k of ['POK_KEY_ID', 'POK_KEY_SECRET', 'POK_MERCHANT_ID']) {
  if (!process.env[k]) console.warn(`WARNING: ${k} is not set — orders will fail`);
}

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`pok order endpoint on :${port} → ${BASE}`));
