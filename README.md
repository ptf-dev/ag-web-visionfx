# ag-web-visionfx

Anduel Gega's site — a link hub (`index.html`), the Gold EA landing page
(`gold-ea-bot.html`), and a checkout (`checkout.html`).

Static HTML, no build step. `gold-ea-bot.html` is a Framer export and is
minified onto very long lines; edit it with anchored replacements rather than
by hand.

| File | What it is |
|---|---|
| `index.html` | Link hub, with a Links and a Shop tab |
| `gold-ea-bot.html` | Gold EA sales page (Framer export) |
| `checkout.html` | PayPal, card and crypto in one place |
| `pok/` | Payments service — see [pok/README.md](pok/README.md) |
| `docs/` | Bank-transfer payment guide |

## Deployment

Lives on **anduelgega.com** → `65.108.121.172`, a Hetzner box in Finland
running Coolify behind nginx. Pushing to `main` deploys automatically; there is
no GitHub Actions workflow and nothing to trigger by hand.

The payments service is a separate container from the same repo. It is not
required for the site to work — PayPal is a plain link and never depends on it.

## HTML caching

The server currently sends `etag` and `last-modified` but **no
`Cache-Control`**. Browsers then fall back to heuristic freshness, roughly 10%
of the age of the file, and keep serving a stale page — which has already
caused a deployed change to look like it had not shipped.

Worth setting on the nginx serving the static site:

```nginx
location ~* \.html$ {
    add_header Cache-Control "no-cache, must-revalidate";
}
```

`no-cache` does not mean "don't cache" — it means "revalidate before use". With
the `etag` already being sent, repeat visits get a cheap `304` and always see
the current page. Leave hashed assets (`js/`, `images/`) cached as they are.

Until that is set, checking a change on a phone needs a hard refresh or a
private tab. Comparing against `curl https://anduelgega.com/<page>` tells you
what is genuinely deployed.

## Payments

Three methods, all on `checkout.html`:

| Method | Provider | Needs the service? |
|---|---|---|
| PayPal | PayPal | no — plain link |
| Card | Pok | yes |
| Crypto | NowPayments | yes |

Card and crypto stay disabled until the service's `/health` confirms each
provider is configured, so neither can be clicked before it works, and either
can go live without the other. Setup and the go-live checklist are in
[pok/README.md](pok/README.md).
