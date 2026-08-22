# Pok card payments

Adds card payment next to PayPal, with the card form on our own page instead of
a redirect — the checkout shape Anduel asked for.

Pok's API keys can never sit in browser code, so a small Cloudflare Worker
creates the order and the page only ever receives an order id.

```
checkout.html  ──POST /api/pok/order──▶  Worker  ──▶  api.pokpay.io
      │                                    │
      │◀────────── { orderId } ────────────┘
      │
      └── PokPayment.renderForm(orderId)  ──▶  card form, on our page
```

## Why the old link failed

The previous integration hard-coded one `sdk-orders/<uuid>` URL and shared it
across both products. A Pok order is a single use record with a fixed amount,
so once it was consumed every visitor got **"Nuk u gjet asnjë porosi!"** — no
order found. That is the error Anduel screenshotted, and it is why a static Pok
link can never work. Orders have to be created per purchase, which is what the
Worker does.

## Setup

### 1. Get credentials

POK Business dashboard → **E-payments** → **API Keys** → create a key.
You need `keyId`, `keySecret`, and the `merchantId` for that key pair.

Staging and production credentials are **not** interchangeable — staging keys
only work against `api-staging.pokpay.io`, production keys only against
`api.pokpay.io`.

### 2. Deploy the Worker

```sh
cd pok
npx wrangler login
npx wrangler secret put POK_KEY_ID
npx wrangler secret put POK_KEY_SECRET
npx wrangler secret put POK_MERCHANT_ID
npx wrangler deploy
```

Secrets are prompted for and stored by Cloudflare. They are never written to
this repo — do not add them to `wrangler.toml`.

### 3. Point the page at it

In `checkout.html`, set `WORKER_URL` to the deployed Worker origin:

```js
var WORKER_URL = 'https://visionfx-pok.<subdomain>.workers.dev';
```

Then add the site's own origin to `ALLOWED_ORIGINS` in `wrangler.toml` and
redeploy. Anything not on that list is refused — that is deliberate, it stops
other sites creating orders against the merchant account.

## Before going live

- [ ] **Confirm the amount unit.** Pok's docs show `"amount": 100` with
      `"currencyCode": "EUR"` and never say whether that means 100 euros or
      100 cents. Create one staging order, read it back with
      `GET /sdk-orders/{id}`, and check. If it is minor units, `PRODUCT.amount`
      in `worker.js` must become `35000`. **Getting this wrong charges €3.50 or
      €35,000 instead of €350.**
- [ ] Run a full staging payment with a [test card](https://docs.pokpay.io/docs/pok-js#test-cards).
- [ ] Set `POK_WEBHOOK_URL` and `POK_REDIRECT_URL` in `wrangler.toml`.
- [ ] Decide fulfilment — `handleWebhook` in `worker.js` currently only logs.
      Licence key and EA file delivery hooks in there.
- [ ] Swap `POK_ENV` to `production` and put production keys in.
- [ ] Only then point the site's buy buttons at `checkout.html`.

## Note on the buy buttons

The live buy buttons on `index.html` and `gold-ea-bot.html` still go straight
to PayPal, which works today. They are deliberately left alone until Pok has
been tested end to end — the last change to those links cost a day of sales.

`checkout.html` is reachable directly for testing and is `noindex`, so nothing
customer-facing changes until someone repoints those buttons.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401` from login | Staging keys on the production host, or the reverse |
| `403` on create order | `merchantId` doesn't belong to that key pair |
| Browser CORS error | Site origin missing from `ALLOWED_ORIGINS` |
| `could_not_create_order` | Check `wrangler tail` — the real reason is logged server-side |
