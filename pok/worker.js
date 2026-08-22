/**
 * Pok Payments order endpoint — Cloudflare Worker.
 *
 * Pok's API credentials may never reach the browser, so order creation has to
 * happen here. The page calls POST /api/pok/order, gets back nothing but an
 * order id, and hands that id to PokPayment.renderForm.
 *
 * Routes:
 *   POST /api/pok/order       create an order for the lifetime package
 *   GET  /api/pok/order/:id   read an order back (used to confirm payment)
 *   POST /api/pok/webhook     Pok calls this when an order changes state
 *
 * Secrets live in Worker secrets, never in this file:
 *   wrangler secret put POK_KEY_ID
 *   wrangler secret put POK_KEY_SECRET
 *   wrangler secret put POK_MERCHANT_ID
 */

/**
 * The price is fixed here, on the server, on purpose. If the browser were
 * allowed to send an amount, anyone could open devtools and buy the package
 * for one euro.
 *
 * !! VERIFY THE UNIT ON STAGING BEFORE GOING LIVE !!
 * Pok's docs show `"amount": 100` with `"currencyCode": "EUR"` but never say
 * whether that is 100 euros or 100 cents. Create one staging order and read
 * the amount back before pointing real customers at this. Getting it wrong
 * means charging EUR 3.50 or EUR 35,000 instead of EUR 350.
 */
const PRODUCT = {
  amount: 350,
  currencyCode: 'EUR',
  label: 'Paketa Premium + Gold EA Vision — Lifetime',
};

const API = {
  staging: 'https://api-staging.pokpay.io',
  production: 'https://api.pokpay.io',
};

/* ------------------------------------------------------------------ CORS */

function corsHeaders(env, request) {
  // Explicit origins only. A wildcard here would let any site create orders
  // against this merchant account.
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(body, status, env, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env, request) },
  });
}

/* ------------------------------------------------------------------ auth */

// Reuse a token across requests while the isolate is warm rather than logging
// in on every checkout. Lifetime comes from the login response — production
// returned expiresIn 28800000 (8 hours) when this was checked.
let cachedToken = null;

async function getAccessToken(env, base) {
  const now = Date.now();
  if (cachedToken && cachedToken.base === base && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.token;
  }

  const res = await fetch(`${base}/auth/sdk/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyId: env.POK_KEY_ID, keySecret: env.POK_KEY_SECRET }),
  });

  if (!res.ok) {
    // 401 here almost always means staging keys against the production host,
    // or the reverse.
    throw new Error(`pok login failed: ${res.status}`);
  }

  const body = await res.json();
  const token = body?.data?.accessToken;
  if (!token) throw new Error('pok login returned no accessToken');

  // expiresIn is milliseconds. Fall back to 5 minutes if it is missing.
  const ttl = Number(body?.data?.expiresIn) || 300_000;
  cachedToken = { token, base, expiresAt: now + ttl };
  return token;
}

/* --------------------------------------------------------------- handlers */

async function createOrder(request, env) {
  const base = API[env.POK_ENV === 'production' ? 'production' : 'staging'];
  const token = await getAccessToken(env, base);

  const res = await fetch(`${base}/merchants/${env.POK_MERCHANT_ID}/sdk-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      amount: PRODUCT.amount,
      currencyCode: PRODUCT.currencyCode,
      autoCapture: true,
      shippingCost: 0,
      webhookUrl: env.POK_WEBHOOK_URL || undefined,
      redirectUrl: env.POK_REDIRECT_URL || undefined,
    }),
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // 403 here means the merchantId does not belong to this key pair.
    console.error('pok create order failed', res.status, body?.message);
    return json({ error: 'could_not_create_order' }, 502, env, request);
  }

  const orderId = body?.data?.sdkOrder?.id || body?.data?.id;
  if (!orderId) {
    console.error('pok create order returned no id');
    return json({ error: 'could_not_create_order' }, 502, env, request);
  }

  // Only the order id crosses back to the browser.
  return json({ orderId, amount: PRODUCT.amount, currency: PRODUCT.currencyCode }, 200, env, request);
}

async function readOrder(request, env, orderId) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(orderId)) {
    return json({ error: 'bad_order_id' }, 400, env, request);
  }

  const base = API[env.POK_ENV === 'production' ? 'production' : 'staging'];
  const token = await getAccessToken(env, base);

  const res = await fetch(`${base}/sdk-orders/${orderId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) return json({ error: 'not_found' }, 404, env, request);

  const order = body?.data?.sdkOrder || body?.data || {};
  // Deliberately narrow: the page only needs to know whether it is paid.
  return json(
    { id: order.id, status: order.status, amount: order.amount, capturedAmount: order.capturedAmount },
    200,
    env,
    request
  );
}

async function handleWebhook(request, env) {
  // Anyone can POST here, so treat the body as a hint, never as proof of
  // payment. Re-read the order from the API before acting on it.
  const body = await request.json().catch(() => null);
  const orderId = body?.sdkOrderId || body?.data?.sdkOrder?.id || body?.id;
  console.log('pok webhook', JSON.stringify({ orderId, status: body?.status }));

  // Fulfilment goes here once the owner decides how licences are issued
  // (email with licence key + EA file). Until then this only records receipt.
  return new Response('ok', { status: 200 });
}

/* ------------------------------------------------------------------ entry */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    try {
      if (path === '/api/pok/order' && request.method === 'POST') {
        return await createOrder(request, env);
      }

      const read = path.match(/^\/api\/pok\/order\/([^/]+)$/);
      if (read && request.method === 'GET') {
        return await readOrder(request, env, read[1]);
      }

      if (path === '/api/pok/webhook' && request.method === 'POST') {
        return await handleWebhook(request, env);
      }

      return json({ error: 'not_found' }, 404, env, request);
    } catch (err) {
      // Log the detail, return none of it — Pok's error messages can leak
      // implementation detail.
      console.error('pok worker error', err?.message);
      return json({ error: 'server_error' }, 500, env, request);
    }
  },
};
