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
