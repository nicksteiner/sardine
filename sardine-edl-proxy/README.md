# sardine-edl-proxy

Tiny Cloudflare Worker that lets the hosted SARdine build at
[nicksteiner.github.io/sardine](https://nicksteiner.github.io/sardine/)
stream NASA DAAC data over CORS. Mirrors the dev-server proxy in
`vite.config.js`.

## How it works

```
browser  ──GET /proxy?url=<daac url>──>  this Worker
                                              │
                                              │  Authorization: Bearer <user EDL token>
                                              ▼
                                         ASF / PO.DAAC / etc.
                                              │
                                              │  302 → urs.earthdata.nasa.gov (keep auth)
                                              │  302 → DAAC callback        (keep cookies)
                                              │  307 → signed S3/CloudFront (drop auth ←!)
                                              ▼
                                         range-requested bytes
                                              │
browser  <──streamed with CORS headers────────┘
```

The user pastes their own Earthdata Login token into SARdine; the Worker
just adds CORS and follows the redirect chain.

**No server-side secrets. No OAuth registration. No KV. No state.**

## Threat model (v1)

- **Target hosts are hard-allowlisted** in `worker.js` (`ALLOWED_HOSTS`).
- **Browser origins are hard-allowlisted** (`ALLOWED_ORIGINS`) — currently
  `https://nicksteiner.github.io` and `localhost:5173`.
- **Every request must carry an EDL token.** Tokens are passed via the
  `X-EDL-Token` header (preferred) or `?t=…` query string (fallback for
  h5chunk's raw fetches).
- **Authorization is dropped on cross-allowlist redirects** so the token
  never reaches S3 / CloudFront access logs.
- **2 GiB response cap** — refuse before streaming.

If a token leaks, an attacker has the same access the user already had
to NASA data, and we accept that risk because EDL tokens are revocable
and short-lived (60-day default). They cannot use the Worker for anything
else because of the host + origin allowlists.

## Endpoints

- `GET /` — health check + config dump
- `GET /proxy?url=<urlencoded>` — main proxy. Requires token.
- `GET /whoami` — forwards to `urs.earthdata.nasa.gov/api/users/user`,
  used by SARdine to validate a pasted token.

## Deploy

```bash
npm install
npx wrangler login    # one-time
npm run deploy
```

Production URL will be `https://sardine-edl-proxy.<your-handle>.workers.dev`.
Paste that into SARdine's Earthdata settings panel.

## Local dev

```bash
npm run dev           # wrangler dev on localhost:8787
# Then in SARdine, set proxy URL to http://localhost:8787
```

## Cost

- Free tier: 100K requests/day, unlimited bandwidth
- Paid: $5/month + $0.30 per million requests over 10M

For SARdine usage (range-heavy chunked HDF5 reads), the free tier covers
~10–20 user-hours per day. If you need a hard ceiling, configure a daily
request limit in the Cloudflare dashboard.

## Logs

```bash
npm run tail
```

## Adding allowed hosts

Edit `ALLOWED_HOSTS` in `worker.js` and redeploy. Suffix-matched, so
`asf.alaska.edu` matches all subdomains.

## Adding allowed origins

Edit `ALLOWED_ORIGINS` in `worker.js` and redeploy. If you fork SARdine
and host it elsewhere, add your origin or set the array to `[]` (which
sends `Access-Control-Allow-Origin: *`).
