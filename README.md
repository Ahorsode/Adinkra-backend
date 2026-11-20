# Adinkra Airways API — Cloudflare Workers + Neon

The backend of Adinkra Airways, rewritten from Express + SQLite to run on **Cloudflare Workers**, using
three Neon services: **Postgres** (through Cloudflare **Hyperdrive**), **Neon Auth** (Managed Better Auth)
for sign-in, and **Neon Realtime** for live flight status. The frontend lives in the
[Adinkra-frontend](https://github.com/Ahorsode/Adinkra-frontend) repo and is hosted on Vercel; it reaches
this API through a Vercel rewrite of `/api/*`, so the browser sees one site and every cookie is first-party.

```
Browser ──► Vercel (static site)
  │           └─ /api/* rewrite ──► Cloudflare Worker (Hono) ──┬─► Hyperdrive ──► Neon Postgres
  │                                                            └─► Neon Auth (sign-up, sign-in, sessions)
  └─ WebSocket (live flight status) ───────────────────────────────► Neon Realtime
```

## Live deployment

| | |
| --- | --- |
| Website | https://adinkra-airways.vercel.app (Vercel project `adinkra-airways`, deploys on every push to Adinkra-frontend) |
| API Worker | https://adinkra-airways-api.ahorsodebenjamindelali.workers.dev (`npm run deploy` from this folder) |
| Database | Neon project `Adinkra`, branch `production` (aws-us-east-2), through Hyperdrive `adinkra-db` (caching off) |
| Auth / Realtime | Neon Auth and Neon Realtime on the same branch; trusted origin `https://adinkra-airways.vercel.app` |

Check it any time with `node scripts/smoke.js https://adinkra-airways.vercel.app`.

## What changed from the original server

| Original (Express + SQLite) | Hosted version |
| --- | --- |
| Express 5 | [Hono](https://hono.dev) (built for Workers; handlers read almost the same) |
| `node:sqlite`, synchronous queries | Postgres via `postgres` (postgres.js) + Hyperdrive; every query is `await`ed |
| `BEGIN IMMEDIATE` serialised all writes | Real transactions; seat assignment and cargo approval lock the flight row (`SELECT … FOR UPDATE`) so two people can't take the same seat |
| scrypt hashes + `sessions` table + `adk_sid` cookie | **Neon Auth**: identities, passwords and sessions live in Neon (`neon_auth` schema). `users` keeps the profile, role and permissions, linked by `auth_user_id` |
| — | **Forgot password** with a 6-digit code emailed by Neon Auth |
| Flight status page polled every 30 s | **Neon Realtime** live query: the board updates the moment ops change a delay, gate or status (30 s polling stays as fallback) |
| PDFKit (reads font files from disk) | pdf-lib, same e-ticket layout, QR drawn as vector squares |
| `qrcode.toDataURL` (needs a canvas on Workers) | Small PNG encoder in `src/qr.js` |
| In-memory login / lookup rate limits | `rate_limits` table, shared by all Worker instances |
| `setInterval` to expire seat holds | Cron trigger every minute (holds are also expired on each relevant request) |
| `data/keys.json` | `DATA_KEY` / `HMAC_KEY` Worker secrets |

Timestamps are still stored as ISO-8601 UTC text, exactly like the original, so the API returns the same
shapes and the website's pages needed only small additions.

### How sign-in works

The website keeps calling the app's own endpoints (`/api/auth/register`, `/login`, `/logout`, `/me`,
`/forgot-password`, `/reset-password`). The Worker calls Neon Auth server-to-server with Neon's
framework-agnostic toolkit (`@neon/auth/server`, the same pieces Neon's Next.js adapter is built on, see
`src/neonauth.js`), so Neon's session cookies are set on the site's own domain. On every request the Worker
reads the Neon Auth session (cached in a signed cookie for 5 minutes, so most requests don't call Neon), then
applies the app's rules: the profile must be linked and **active**, and the session must be younger than the
admin's **session timeout** setting. Roles, staff permissions, Ghana Card validation, login lockout and the
audit log are unchanged.

### How live status works

`GET /api/live/board` and `/api/live/status` return a **sealed** live query (encrypted, valid ~60 s) over the
flights on screen. The browser subscribes over Neon's WebSocket (`public/vendor/neon-realtime.js`), renews
before expiry, and refetches the page's normal data whenever those rows change.

## Deploy (first time)

You need Node.js 22+, the Neon CLI (`npm i -g neon`), a Neon account and a Cloudflare account.
Commands are for PowerShell, run inside this folder.

**1. Install**

```powershell
npm install
```

**2. Link Neon and apply `neon.ts`.** `neon.ts` declares Postgres, Auth and Realtime. Linking pulls the
branch's settings (`DATABASE_URL`, `NEON_AUTH_BASE_URL`, `NEON_REALTIME_*`, …) into `.env` (git-ignored).

```powershell
neon login
```

```powershell
neon link --project-id <your-project-id> --branch production
```

```powershell
neon deploy
```

Realtime and Functions-style services need one of Neon's supported regions (this project uses `aws-us-east-2`).

**3. Generate the encryption keys** (written to `.dev.vars`, git-ignored). Keep a copy somewhere safe:
if `DATA_KEY` is lost, encrypted passports and Ghana Card numbers can't be read.

```powershell
npm run secrets:generate
```

**4. Create the tables, demo data and demo sign-in accounts** (several minutes over the network; the demo
accounts are created in Neon Auth):

```powershell
npm run db:seed
```

A database seeded before Neon Auth was added only needs its demo accounts linked: `npm run db:link-auth`.

**5. Connect Cloudflare and create Hyperdrive** with the branch's **direct** connection string
(`DATABASE_URL_UNPOOLED` in `.env`; Hyperdrive does its own pooling) and caching off, so bookings never
show stale data:

```powershell
npx wrangler login
```

```powershell
npx wrangler hyperdrive create adinkra-db --caching-disabled --connection-string="<DATABASE_URL_UNPOOLED from .env>"
```

Paste the `id` it prints into `wrangler.jsonc` → `hyperdrive[0].id`.

**6. Deploy, then upload the secrets.** `secrets:sync` copies the Neon Auth and Realtime settings from `.env`
into `.dev.vars` and creates `NEON_AUTH_COOKIE_SECRET` once; `secrets:upload` sends `.dev.vars` to the Worker.

```powershell
npm run deploy
```

```powershell
npm run secrets:sync
```

```powershell
npm run secrets:upload
```

**7. Connect the frontend.** `npm run deploy` printed the Worker URL, e.g.
`https://adinkra-airways-api.<your-subdomain>.workers.dev`. Put it into the frontend's `vercel.json` rewrite,
then deploy the frontend (see its README).

**8. Trust the site's address in Neon.** Neon Auth rejects sign-ins from unknown origins ("Invalid origin"),
and Realtime should only accept your site. With your Vercel URL:

```powershell
neon neon-auth domain add https://your-site.vercel.app
```

```powershell
neon realtime enable --allowed-origin https://your-site.vercel.app --allowed-origin http://localhost:3000
```

**9. Check it**:

```powershell
node scripts/smoke.js https://your-site.vercel.app
```

## Plans and limits

- **Neon Auth request limit.** Neon Auth allows roughly 10 auth calls per few seconds **per IP address**
  (measured on this project). Every sign-in, sign-up and password change reaches Neon from Cloudflare's servers,
  so at peak, visitors share that budget; forwarded-IP headers are ignored. Ordinary page loads don't count
  (sessions are re-checked with Neon at most once per user every 5 minutes). Fine for a class project or a
  small launch; if bursts of sign-ins become common, ask Neon about limits for server-side proxies. The API
  turns Neon's limit into "Too many attempts. Please wait a minute", and logs it.
- **Auth emails** (reset codes) use Neon's shared sender while you're getting started. Before a real launch,
  set up your own SMTP: <https://neon.com/docs/auth/production-checklist>.
- **Workers Free** allows 10 ms of CPU per request; database and network time don't count. PDF generation can
  exceed it now and then. For a live site the **Workers Paid** plan ($5/month) removes that risk.
- **Neon Free** suspends the database after 5 minutes idle; the first request after that takes a second or
  two longer. The demo data uses roughly 150 MB of the 0.5 GB free storage.
- Login lockout uses the visitor IP from `X-Forwarded-For` (set by Vercel), per *IP + email* as in the original.

## Local development

Two options for the database:

- **Neon `dev` branch** (recommended; needed for sign-in, since Auth runs on Neon): create it once and pull its
  settings into `.env.dev`:

  ```powershell
  neon branches create --name dev --parent production
  ```

  ```powershell
  neon env pull --branch dev --file .env.dev
  ```

  Point local `wrangler dev` at it with `node scripts/sync-neon-env.js .env.dev`
  (run `npm run secrets:sync` afterwards to switch `.dev.vars` back to production before uploading).

- **PGlite** (real Postgres compiled to WebAssembly) for app data with no network: `npm run db:local`, then
  `$env:DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5433/postgres"; npm run db:reset`.

Run the Worker with `npm run dev` (http://127.0.0.1:8787) and the website with `npm run dev` in the frontend folder.

## Tests

```powershell
npm test
```

Runs the assignment's scenarios (1.1–3.5, RBAC, CSRF, lockout, encryption), the full Neon Auth flow
(register, session restore, sign-out, sign-in, wrong password, password change, reset code, deactivation)
and Realtime sealing. App data uses a throw-away in-memory Postgres; sign-in uses Neon Auth on the **dev**
branch (`.env.dev`), never production. Accounts the tests create get unique emails. The suite waits and
retries when Neon's request limit kicks in, so a run takes about a minute.

## Layout

```
src/
  index.js        Worker entry: per-request DB connection, cron handler
  app.js          Hono app, request adapter, CSRF guard, error handler
  neonauth.js     Neon Auth adapter for Hono (@neon/auth/server toolkit)
  db.js           postgres.js helpers (one/all/run/insert/insertMany/tx), settings
  security.js     Encryption, signed tokens, session → app user, RBAC, audit, rate limiting
  services.js     Booking logic (seats, changes, cancellations, notifications)
  domain.js       Business rules (unchanged from the original)
  eticket.js      PDF e-ticket (pdf-lib)
  qr.js           QR → PNG data URL
  routes/         auth, flights, bookings, profile, cargo, support, staff, admin, live (Realtime)
db/schema.sql     Postgres schema (also upgrades older databases)
neon.ts           Neon services for this project (Postgres, Auth, Realtime)
scripts/          seed + Neon Auth linking, schema, Neon env sync, local Postgres, keys, smoke test
test/             End-to-end API tests
```

## Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Traveller | `kwame.mensah@example.com` | `Traveler@2026` |
| Staff | `abena.ofori@adinkra-air.test` | `Staff@2026` |
| Staff (flight ops) | `yaw.darko@adinkra-air.test` | `Staff@2026` |
| Admin | `kojo.addo@adinkra-air.test` | `Admin@2026` |

These are public demo passwords stored in Neon Auth. Change them (or create new admin accounts and deactivate
these) before sharing a live link outside class.
