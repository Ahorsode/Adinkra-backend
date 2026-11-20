# Adinkra Airways API — Cloudflare Workers + Neon Postgres

The backend of Adinkra Airways, rewritten from Express + SQLite to run on **Cloudflare Workers**
with **Neon Postgres** (through **Hyperdrive**). The frontend lives in the
[Adinkra-frontend](https://github.com/Ahorsode/Adinkra-frontend) repo and is hosted on Vercel; it reaches
this API through a Vercel rewrite of `/api/*`, so the browser sees one site and the session cookie stays first-party.

```
Browser ──► Vercel (static frontend)
              └─ /api/* rewrite ──► Cloudflare Worker (Hono) ──► Hyperdrive ──► Neon Postgres
```

## What changed from the original server

| Original (Express + SQLite) | Hosted version |
| --- | --- |
| Express 5 | [Hono](https://hono.dev) (built for Workers; handlers read almost the same) |
| `node:sqlite`, synchronous queries | Postgres via `postgres` (postgres.js) + Hyperdrive; every query is `await`ed |
| `BEGIN IMMEDIATE` serialised all writes | Real transactions; seat assignment and cargo approval lock the flight row (`SELECT … FOR UPDATE`) so two people can't take the same seat |
| scrypt password hashes | PBKDF2-SHA256, 100,000 iterations (WebCrypto) — scrypt is too CPU-heavy for Workers |
| PDFKit (reads font files from disk) | pdf-lib, same e-ticket layout, QR drawn as vector squares |
| `qrcode.toDataURL` (needs a canvas on Workers) | Small PNG encoder in `src/qr.js` |
| In-memory login / lookup rate limits | `rate_limits` table, shared by all Worker instances |
| `setInterval` to expire seat holds | Cron trigger every minute (holds are also expired on each relevant request) |
| `data/keys.json` | `DATA_KEY` / `HMAC_KEY` Worker secrets |
| SQLite SQL (`strftime`, `julianday`, `group_concat`, `GLOB`…) | Postgres equivalents |

Timestamps are still stored as ISO-8601 UTC text, exactly like the original, so the API returns the same
shapes and the frontend did not need changes.

## Deploy (first time)

You need: Node.js 22+, a [Neon](https://neon.tech) account and a [Cloudflare](https://dash.cloudflare.com) account.
Commands are for PowerShell, run inside this folder.

**1. Install**

```powershell
npm install
```

**2. Create the Neon database.** In the Neon console create a project (region: *AWS Europe (Frankfurt)* or
*London* is closest to Ghana). Under **Connect**, turn **Connection pooling off** and copy the *direct*
connection string (the host must **not** contain `-pooler`). Hyperdrive does its own pooling.

**3. Generate the encryption keys.** This writes them to `.dev.vars` (git-ignored) and prints them.
Keep a copy somewhere safe: if `DATA_KEY` is lost, encrypted passports and Ghana Card numbers can't be read.

```powershell
npm run secrets:generate
```

**4. Create the tables and load the demo data into Neon** (about a minute; uses the same keys as the Worker):

```powershell
$env:DATABASE_URL = "postgresql://...your direct Neon string..."
$env:DATA_KEY = "...from step 3..."
$env:HMAC_KEY = "...from step 3..."
npm run db:seed
```

**5. Connect Cloudflare and create Hyperdrive** (caching off so bookings never show stale data):

```powershell
npx wrangler login
```

```powershell
npx wrangler hyperdrive create adinkra-db --caching-disabled --connection-string="postgresql://...your direct Neon string..."
```

Paste the `id` it prints into `wrangler.jsonc` → `hyperdrive[0].id`.

**6. Add the secrets to the Worker** (paste the values from step 3 when asked):

```powershell
npx wrangler secret put DATA_KEY
```

```powershell
npx wrangler secret put HMAC_KEY
```

**7. Deploy**

```powershell
npm run deploy
```

Wrangler prints the Worker URL, e.g. `https://adinkra-airways-api.<your-subdomain>.workers.dev`.
Put it into the frontend's `vercel.json` rewrite, then deploy the frontend (see its README).

**8. Check it** (through Vercel once the frontend is up, or the Worker URL directly):

```powershell
node scripts/smoke.js https://your-site.vercel.app
```

## Plans and limits

- **Workers Free** allows 10 ms of CPU per request. Most API calls use far less (database time doesn't count),
  but login (PBKDF2) and PDF generation can exceed it now and then. For a live site the **Workers Paid** plan
  ($5/month, 30 s CPU) removes that risk. For a class demo the free plan is usually fine.
- **Neon Free** suspends the database after 5 minutes idle; the first request after that takes ~1 s longer.
  The demo data uses roughly 150 MB of the 0.5 GB free storage.
- Login lockout uses the visitor IP from `X-Forwarded-For` (set by Vercel). Someone calling the Worker URL
  directly could fake that header, so the lockout is per *IP + email*, as in the original.

## Local development (no Neon needed)

Uses [PGlite](https://pglite.dev) — real Postgres compiled to WebAssembly — as a local database.

```powershell
npm run db:local
```

In a second terminal (first time only, then whenever you want fresh demo data):

```powershell
$env:DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5433/postgres"; Get-Content .dev.vars | ForEach-Object { $k, $v = $_ -split '=', 2; Set-Item "env:$k" $v }; npm run db:reset
```

Then run the Worker locally (`.dev.vars` needs `DB_MAX_CONNECTIONS=1` for PGlite):

```powershell
npm run dev
```

The API is on http://127.0.0.1:8787. To use the website against it, run `node dev-server.mjs` in the frontend folder.

## Tests

```powershell
npm test
```

Runs the assignment's scenarios (1.1–3.5, RBAC, CSRF, lockout, encryption) against a throw-away in-memory Postgres.

## Layout

```
src/
  index.js        Worker entry: per-request DB connection, cron handler
  app.js          Hono app, request adapter, CSRF guard, error handler
  db.js           postgres.js helpers (one/all/run/insert/insertMany/tx), settings
  security.js     Hashing, encryption, signed tokens, sessions, RBAC, audit, rate limiting
  services.js     Booking logic (seats, changes, cancellations, notifications)
  domain.js       Business rules (unchanged from the original)
  eticket.js      PDF e-ticket (pdf-lib)
  qr.js           QR → PNG data URL
  routes/         auth, flights, bookings, profile, cargo, support, staff, admin
db/schema.sql     Postgres schema
scripts/          seed, schema, local Postgres, key generation, smoke test
test/             End-to-end API tests
```

## Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Traveller | `kwame.mensah@example.com` | `Traveler@2026` |
| Staff | `abena.ofori@adinkra-air.test` | `Staff@2026` |
| Staff (flight ops) | `yaw.darko@adinkra-air.test` | `Staff@2026` |
| Admin | `kojo.addo@adinkra-air.test` | `Admin@2026` |

These are public demo passwords. Change them (or create new admin accounts and deactivate these) before
sharing a live link outside class.
