# Payments service

Backs the three payment methods on `checkout.html`:

| Method | Provider | How it runs |
|---|---|---|
| PayPal | PayPal | plain link, no server involved |
| Card | Pok | card form rendered on our own page |
| Crypto | NowPayments | redirect to a hosted invoice |

PayPal needs nothing. The other two need API keys that can never sit in browser
code, so a small service creates the order or invoice server-side and the page
only ever receives an id or a URL.

```
checkout.html ──POST /api/pok/order─────────▶ service ──▶ api.pokpay.io
      │◀──────────── { orderId } ─────────────┘
      └── PokPayment.renderForm(orderId) ──▶ card form, on our page

checkout.html ──POST /api/nowpayments/invoice ▶ service ──▶ api.nowpayments.io
      │◀──────────── { url } ─────────────────┘
      └── redirect ──▶ hosted invoice, pick a coin
```

The folder is still named `pok/` for continuity; it serves all providers.

Prices are set server-side in both paths, never sent from the browser —
otherwise anyone could open devtools and buy the package for a euro.

## Why the old link failed

The previous integration hard-coded one `sdk-orders/<uuid>` URL and shared it
across both products. A Pok order is a single use record with a fixed amount,
so once it was consumed every visitor got **"Nuk u gjet asnjë porosi!"** — no
order found. That is the error Anduel screenshotted, and it is why a static Pok
link can never work. Orders have to be created per purchase, which is what the
Worker does.

## Setup

### 1. Get credentials

Log in to **POK Business** on desktop (business.pokpay.io — the same account as
the POK Business phone app, but the API keys screen is web only).

In the left sidebar, the menu Pok's docs call **E-payments** is the second item,
and it is translated to whatever language the dashboard is set to:

| Dashboard language | Sidebar item |
|---|---|
| Albanian (`AL`) | **Pagesat online** |
| English (`EN`) | **Online payments** |
| Italian (`IT`) | **Pagamenti online** |

The language switcher is the row of flags at the bottom of the sidebar, below
*Mercato / Tregu / Market*.

Open that menu → **API Keys** → create a key. Copy all three values:

- `keyId`
- `keySecret` — shown **once**, at creation. If it is lost, create a new key.
- `merchantId` — must be the merchant this key pair belongs to, or order
  creation returns `403`.

Staging and production credentials are **not** interchangeable — staging keys
only work against `api-staging.pokpay.io`, production keys only against
`api.pokpay.io`.

> **The keys the dashboard hands you are production keys.** Checked against
> both hosts: `api.pokpay.io/auth/sdk/login` returns `200` with a token
> (`expiresIn` 28800000, i.e. 8 hours), while `api-staging.pokpay.io` rejects
> the same pair with `400 — "Your credentials are incorrect"`.
>
> There is no staging toggle in the API Keys screen, so **staging credentials
> have to be requested from POK support**. Ask for them before the checklist
> below — it is the only way to test a real card payment without moving real
> money. If POK will not issue them, see *Testing without staging keys*.

Nothing from this step goes in the repo. The three values are set as Worker
secrets in step 2.

### 2. Deploy the service

Two builds of the same endpoint are in this folder. Pick one:

- **`server.js` + `Dockerfile`** — plain Node container, for Coolify. Use this
  if the site is already on Coolify.
- **`worker.js` + `wrangler.toml`** — Cloudflare Worker. Same routes.

#### One command on the server

`deploy.sh` does the whole thing — builds, runs, waits for health, and prints
the routing step that is left. Run it on the box, from this folder:

```sh
cd ag-web-visionfx/pok
POK_KEY_ID=... POK_KEY_SECRET=... POK_MERCHANT_ID=... \
NOWPAYMENTS_API_KEY=... NOWPAYMENTS_IPN_SECRET=... \
./deploy.sh
```

It binds the container to `127.0.0.1:3000` rather than a public port, so the
service is only reachable through the site's own proxy. It never touches the
site, nginx or Traefik — if the container fails to start it says so and exits
non-zero, and the checkout simply keeps falling back to PayPal.

Then add the routing it prints, and `curl https://anduelgega.com/health` to
confirm. The card and crypto buttons switch themselves on from that response;
no site redeploy is needed.

#### Coolify UI

In the Coolify dashboard, on the same server as the site:

1. **New Resource → Application → Docker / Dockerfile**, pointing at this repo.
2. Set **Base Directory** to `/pok` so it builds this folder's `Dockerfile`.
3. Environment variables:

   | Key | Value |
   |---|---|
   | `POK_KEY_ID` | Pok dashboard |
   | `POK_KEY_SECRET` | Pok dashboard — mark it **secret** |
   | `POK_MERCHANT_ID` | Pok dashboard |
   | `POK_ENV` | `production` |
   | `ALLOWED_ORIGINS` | the site's origin, e.g. `https://anduelgega.com` |
   | `NOWPAYMENTS_API_KEY` | NowPayments → Payments API — mark it **secret** |
   | `NOWPAYMENTS_IPN_SECRET` | NowPayments → Payments API — mark it **secret** |
   | `NOWPAYMENTS_IPN_URL` | `https://<service-domain>/api/nowpayments/ipn` |
   | `NOWPAYMENTS_SUCCESS_URL` | `https://anduelgega.com/checkout.html?paid=1` |

   Crypto switches itself on only when `NOWPAYMENTS_API_KEY` is present —
   `/health` reports `providers.crypto`, and the page hides the tab's button
   until it is true. So the card path can go live before crypto, or the
   reverse, with no code change.

4. Port **3000**. Health check path **`/health`**.
5. Give it a domain — either a subdomain (`pok.<site>`) or a path route on the
   site's domain.

Then confirm it is up:

```sh
curl https://<service-domain>/health
# {"ok":true,"env":"https://api.pokpay.io"}
```

`ALLOWED_ORIGINS` matters: it is an explicit allowlist, not a wildcard, so any
other site trying to create orders against this merchant account is refused.

#### Cloudflare Workers

```sh
cd pok
npx wrangler login
npx wrangler secret put POK_KEY_ID
npx wrangler secret put POK_KEY_SECRET
npx wrangler secret put POK_MERCHANT_ID
npx wrangler deploy
```

Secrets are prompted for and stored by Cloudflare. Either way they are never
written to this repo — do not put them in `wrangler.toml`.

### 3. Point the page at it

In `checkout.html`, near the bottom:

```js
var POK_API = '';   // '' = same origin
```

Leave it empty **only** if the site proxies `/api/pok/*` to the container. If
the service has its own domain, set it:

```js
var POK_API = 'https://pok.goldea.ai';
```

and make sure that origin's `ALLOWED_ORIGINS` includes the site.

If the service is unreachable the card option fails politely and points the
customer at PayPal, which never depends on it.

## Before going live

- [ ] **Confirm the amount unit. Still unresolved — do this first.** Pok's docs
      show `"amount": 100` with `"currencyCode": "EUR"` and never say whether
      that means 100 euros or 100 cents. Run `./check-amount.sh` (below) and
      set `AMOUNT_IN_MINOR_UNITS` in `worker.js` from what the dashboard shows.
      **Getting this wrong charges €3.50 or €35,000 instead of €350.**
- [ ] Run a full payment with a [test card](https://docs.pokpay.io/docs/pok-js#test-cards)
      (staging only — test cards do not work against production).
- [ ] Set `POK_WEBHOOK_URL` and `POK_REDIRECT_URL` in `wrangler.toml`.
- [ ] Decide fulfilment — `handleWebhook` in `worker.js` currently only logs.
      Licence key and EA file delivery hooks in there.
- [ ] Swap `POK_ENV` to `production` and put production keys in.
- [ ] Only then point the site's buy buttons at `checkout.html`.

### Testing without staging keys

If POK will not issue staging credentials, the amount unit can still be settled
on production without risking a real charge: create **one order for `amount: 1`**
and read it straight back. An SDK order that nobody pays moves no money and
simply expires.

```sh
cd pok
POK_KEY_ID=... POK_KEY_SECRET=... POK_MERCHANT_ID=... ./check-amount.sh
```

Then open that order in the POK Business dashboard under *Pagesat online* and
set one flag at the top of `worker.js` from what it shows:

| Dashboard shows | `AMOUNT_IN_MINOR_UNITS` | Order sent as |
|---|---|---|
| **€1.00** | `false` (current default) | `350` |
| **€0.01** | `true` | `35000` |

Do not skip this because the numbers look obvious — the whole point is that the
docs do not say, and the default is a guess until someone checks.

## Note on the buy buttons

The buy buttons on `index.html` (1) and `gold-ea-bot.html` (4) now point at
`checkout.html`, which offers PayPal and card side by side.

PayPal on that page is a plain link to the same URL the buttons used before, so
it keeps working whether or not the Pok service is deployed, reachable, or
configured. Card is the only thing that depends on the container.

If the checkout page ever needs to be taken out of the path, point those five
links straight back at:

```
https://www.paypal.com/ncp/payment/J4CL6SY9AAH9Y
```

## NowPayments notes

Its unit is unambiguous, unlike Pok's: the API echoes back `price_amount: "1"`
with `price_currency: "EUR"`, i.e. plain euros. `PRICE_EUR` is used directly.

IPN callbacks are signed with HMAC-SHA512 over the JSON body **with its keys
sorted**, in the `x-nowpayments-sig` header. `/api/nowpayments/ipn` verifies
that and returns `401` otherwise — without it anyone could POST a `finished`
payment and claim a licence. Verified against genuine, forged, tampered, and
unsigned bodies.

Set the IPN URL in the NowPayments dashboard (Payments API → *Add your IPN
URL*) to `https://<service-domain>/api/nowpayments/ipn`.

Only `payment_status: "finished"` means settled — `partially_paid` and
`confirming` do not.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401` from Pok login | Staging keys on the production host, or the reverse |
| `403` on create order | `merchantId` doesn't belong to that key pair |
| Browser CORS error | Site origin missing from `ALLOWED_ORIGINS` |
| Card tab stays disabled | `/health` unreachable, or `providers.card` false |
| Crypto tab stays disabled | `NOWPAYMENTS_API_KEY` not set on the container |
| `bad_signature` on IPN | `NOWPAYMENTS_IPN_SECRET` doesn't match the dashboard |
| `could_not_create_order` | Check container logs — the real reason is logged server-side |
