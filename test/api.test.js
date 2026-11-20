// End-to-end API tests covering the assignment's user scenarios: `npm test`.
//
// App data: a throw-away in-memory Postgres (PGlite).
// Sign-in: Neon Auth on the Neon *dev* branch (NEON_AUTH_BASE_URL from .env.dev), never production.
// Accounts the tests create use unique emails, so runs don't collide; the demo accounts are created
// on the dev branch on first run and reused afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATA_KEY ||= crypto.randomBytes(32).toString('hex');
process.env.HMAC_KEY ||= crypto.randomBytes(32).toString('hex');
process.env.NEON_AUTH_COOKIE_SECRET ||= crypto.randomBytes(32).toString('base64');
if (!process.env.NEON_AUTH_BASE_URL) {
  console.error('NEON_AUTH_BASE_URL is not set. Create the dev branch env first: neon env pull --branch dev --file .env.dev');
  process.exit(1);
}

const RUN = Date.now().toString(36);
const ORIGIN = 'http://localhost:3000'; // a trusted origin on every Neon Auth branch

const { startLocalDb } = await import('../scripts/local-db.js');
const { seedIfEmpty, DEMO_ACCOUNTS } = await import('../scripts/seed.js');
const { createApp } = await import('../src/app.js');
const { connect, setDefaultDb, one } = await import('../src/db.js');

const base = 'https://adinkra.test';
let app;
let local;
let sql;
before(async () => {
  local = await startLocalDb({ port: 15433 });
  // PGlite runs all connections in one session, so keep the pool to one connection.
  sql = connect(local.url, { max: 1 });
  setDefaultDb(sql);
  await seedIfEmpty({ light: true });
  app = createApp();
});
after(async () => {
  await sql.end();
  await local.stop();
});

/** Minimal client that keeps cookies like a browser (Neon Auth sets several per response). */
function client() {
  const jar = new Map();
  // Neon Auth allows ~10 auth calls per few seconds per IP, and this suite makes many in a row from
  // one machine: when Neon (not the app's own lockout) says "too many", wait and retry.
  const call = async (method, url, body, headers = {}, tries = 0) => {
    const r = await send(method, url, body, headers);
    if (r.status === 429 && r.body?.error?.startsWith('Too many attempts. Please wait') && tries < 4) {
      await new Promise((ok) => setTimeout(ok, 11000));
      return call(method, url, body, headers, tries + 1);
    }
    return r;
  };
  const send = async (method, url, body, headers) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await app.fetch(new Request(base + url, {
      method,
      headers: { 'X-Requested-With': 'fetch', Origin: ORIGIN, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }));
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';');
      const i = pair.indexOf('=');
      const [name, value] = [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
      if (!value || attrs.some((a) => /max-age=0\b/i.test(a.trim()))) jar.delete(name);
      else jar.set(name, value);
    }
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers, jar };
  };
  return {
    get: (u, h) => call('GET', u, null, h),
    post: (u, b = {}, h) => call('POST', u, b, h),
    put: (u, b = {}) => call('PUT', u, b),
    login: async (acct) => {
      const r = await call('POST', '/api/auth/login', { email: acct.email, password: acct.password });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.user;
    },
  };
}

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

async function findFlight(c, from, to, pax = 1) {
  for (let d = 2; d < 15; d++) {
    const r = await c.get(`/api/flights/search?from=${from}&to=${to}&date=${day(d)}&pax=${pax}`);
    const f = r.body.outbound.find((x) => x.bookable);
    if (f) return f;
  }
  throw new Error(`no ${from}-${to} flight found`);
}

test('health check and security headers', async () => {
  const r = await client().get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('Neon Auth: register, session, sign out, sign in, change password, reset code', async () => {
  const email = `t.${RUN}@example.com`;
  const c = client();
  const bad = await c.post('/api/auth/register', { name: 'Test User', email, phone: '0241112222', nationalId: '123', password: 'abc12345' });
  assert.equal(bad.status, 400);
  const ok = await c.post('/api/auth/register', { name: 'Test User', email, phone: '0241112222', nationalId: 'GHA-123456789-0', password: 'abc12345' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const cookies = ok.headers.getSetCookie().join('\n');
  assert.match(cookies, /__Secure-neon-auth\.session_token=[^;]+;.*HttpOnly/i, 'Neon Auth session cookie set first-party');
  assert.match(cookies, /Secure/);
  const row = await one('SELECT national_id_enc, password_hash, auth_user_id FROM users WHERE email = ?', email);
  assert.match(row.national_id_enc, /^v1:/);
  assert.ok(!row.national_id_enc.includes('123456789'));
  assert.equal(row.password_hash, null, 'the API stores no password');
  assert.match(row.auth_user_id, /^[0-9a-f-]{36}$/, 'linked to the Neon Auth user');
  assert.equal((await c.post('/api/auth/register', { name: 'Test User', email, phone: '0241112222', nationalId: 'GHA-123456789-0', password: 'abc12345' })).status, 409);

  // Session restores on the next request (like a page reload), then signs out.
  assert.equal((await c.get('/api/auth/me')).body.user.email, email);
  assert.equal((await c.get('/api/profile')).status, 200);
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/auth/me')).body.user, null);
  assert.equal((await c.get('/api/profile')).status, 401, 'protected route denied when signed out');

  // Wrong password → clear message; right password → signed in again.
  const wrong = await c.post('/api/auth/login', { email, password: 'nope12345' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'Incorrect email or password');
  await c.login({ email, password: 'abc12345' });

  // Change password through Neon Auth, then sign in with the new one.
  assert.equal((await c.put('/api/profile/password', { currentPassword: 'wrong999', newPassword: 'Newpass123' })).status, 401);
  assert.equal((await c.put('/api/profile/password', { currentPassword: 'abc12345', newPassword: 'Newpass123' })).status, 200);
  const fresh = client();
  assert.equal((await fresh.post('/api/auth/login', { email, password: 'abc12345' })).status, 401);
  await fresh.login({ email, password: 'Newpass123' });

  // Forgotten password: request a code (same answer for unknown emails), wrong code rejected.
  const anon = client();
  assert.equal((await anon.post('/api/auth/forgot-password', { email })).status, 200);
  assert.equal((await anon.post('/api/auth/forgot-password', { email: `nobody.${RUN}@example.com` })).status, 200);
  const r = await anon.post('/api/auth/reset-password', { email, code: '000000', password: 'Another123' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
});

test('Continue with Google: start, failed callback, finish guard, complete profile', async () => {
  const c = client();
  // Start: Neon Auth hands back its Google entry URL and sets the challenge cookie on our domain.
  const start = await c.post('/api/auth/google', { next: '/trips' });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const url = new URL(start.body.url);
  assert.equal(url.origin, new URL(process.env.NEON_AUTH_BASE_URL).origin);
  assert.match(url.pathname, /\/sign-in\/social/);
  assert.ok([...start.jar.keys()].some((k) => k.includes('session_challenge')), 'challenge cookie set');
  // An unsafe "next" falls back to /trips rather than leaving the site.
  const evil = await c.post('/api/auth/google', { next: '//evil.example/x' });
  assert.equal(evil.status, 200);
  // Coming back without a valid verifier, or with a Google error, lands on the login page.
  for (const qs of ['next=%2Ftrips', 'error=access_denied']) {
    const cb = await c.get(`/api/auth/callback?${qs}`);
    assert.equal(cb.status, 302);
    assert.match(cb.headers.get('location'), /^\/#\/login\?error=google/);
  }
  // Finishing without a Neon session is refused.
  assert.equal((await client().post('/api/auth/oauth-finish')).status, 401);

  // A traveller without phone + Ghana Card (as after a Google sign-up) is flagged until they add them.
  const email = `g.${RUN}@example.com`;
  const g = client();
  assert.equal((await g.post('/api/auth/register', { name: 'Google Person', email, phone: '0241112222', nationalId: 'GHA-123456789-0', password: 'abc12345' })).status, 201);
  await one('UPDATE users SET phone = NULL, national_id_enc = NULL WHERE email = ? RETURNING id', email);
  assert.equal((await g.get('/api/auth/me')).body.user.needsProfile, true);
  assert.equal((await g.put('/api/profile/complete', { phone: '0241112222', nationalId: 'bad' })).status, 400);
  assert.equal((await g.put('/api/profile/complete', { phone: '0241112222', nationalId: 'gha-712345678-3' })).status, 200);
  assert.equal((await g.get('/api/auth/me')).body.user.needsProfile, false);
  assert.equal((await client().put('/api/profile/complete', { phone: '0241112222', nationalId: 'GHA-712345678-3' })).status, 401);
});

test('login lockout after repeated failures', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'x' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'x' })).status, 429);
});

test('CSRF guard rejects state-changing calls without the fetch header', async () => {
  const res = await app.fetch(new Request(`${base}/api/auth/logout`, { method: 'POST' }));
  assert.equal(res.status, 403);
});

test('malformed JSON and unknown routes', async () => {
  const res = await app.fetch(new Request(`${base}/api/auth/login`, { method: 'POST', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: '{bad' }));
  assert.equal(res.status, 400);
  assert.equal((await client().get('/api/nope')).status, 404);
  assert.equal((await client().get('/api/flights/99999999999/seats')).status, 404);
});

test('Scenario 1.1: search, book round trip with seats, pay by MoMo, get PDF e-ticket', async () => {
  const c = client();
  await c.login(DEMO_ACCOUNTS.traveler);
  const out = await findFlight(c, 'ACC', 'LHR', 1);
  let ret;
  for (let d = 4; d < 20 && !ret; d++) {
    const r = await c.get(`/api/flights/search?from=LHR&to=ACC&date=${day(d)}&pax=1`);
    ret = r.body.outbound.find((f) => f.bookable && Date.parse(f.departure) > Date.parse(out.arrival) + 7200000);
  }
  assert.ok(ret, 'return flight');
  const seats = await c.get(`/api/flights/${out.id}/seats`);
  const seat = seats.body.rows.filter((r) => r.tier === 'ECONOMY').flatMap((r) => r.groups.flat()).find((s) => !s.taken).id;
  const pax = [{ firstName: 'Kwame', lastName: 'Mensah', dob: '1992-04-18', passportNo: 'G2847561', passportExpiry: '2031-03-14', seats: { out: seat } }];

  const noPassport = await c.post('/api/bookings', { outboundFlightId: out.id, returnFlightId: ret.id, tier: 'ECONOMY', contactPhone: '0244123456', passengers: [{ ...pax[0], passportNo: '' }] });
  assert.equal(noPassport.status, 400, 'international needs passport');

  const hold = await c.post('/api/bookings', { outboundFlightId: out.id, returnFlightId: ret.id, tier: 'ECONOMY', contactPhone: '0244123456', passengers: pax });
  assert.equal(hold.status, 201, JSON.stringify(hold.body));
  const { pnr } = hold.body;

  const taken = await c.post('/api/bookings', { outboundFlightId: out.id, tier: 'ECONOMY', contactPhone: '0244123456', passengers: pax });
  assert.equal(taken.status, 409, 'held seat cannot be double-booked');

  const declined = await c.post(`/api/bookings/${pnr}/pay`, { method: 'MOMO', provider: 'MTN', momoNumber: '0244120000' });
  assert.equal(declined.status, 402);
  const wrongNet = await c.post(`/api/bookings/${pnr}/pay`, { method: 'MOMO', provider: 'MTN', momoNumber: '0201234567' });
  assert.equal(wrongNet.status, 400);
  const paid = await c.post(`/api/bookings/${pnr}/pay`, { method: 'MOMO', provider: 'MTN', momoNumber: '0241234567' });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.booking.status, 'CONFIRMED');
  assert.equal(paid.body.booking.segments.length, 2);
  assert.equal(paid.body.booking.passengers[0].tickets[0].seat, seat);
  assert.ok(paid.body.booking.passengers[0].tickets[0].qr.startsWith('data:image/png'));
  assert.equal((await c.post(`/api/bookings/${pnr}/pay`, { method: 'MOMO', provider: 'MTN', momoNumber: '0241234567' })).status, 409, 'cannot pay twice');

  const pdf = await c.get(`/api/bookings/${pnr}/eticket.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');

  const mine = await c.get('/api/bookings/mine');
  const b = mine.body.bookings.find((x) => x.pnr === pnr);
  assert.equal(b.legs.length, 2);

  const notes = await c.get('/api/profile/notifications');
  assert.ok(notes.body.notifications.some((n) => n.subject.includes(pnr) && n.channel === 'SMS'));
});

test('search suggests nearby dates when a day has no flights', async () => {
  const c = client();
  // NYI is served Mon/Wed/Fri only, so some day in the next week has no ACC→NYI flight.
  let found = false;
  for (let d = 2; d < 9 && !found; d++) {
    const r = await c.get(`/api/flights/search?from=ACC&to=NYI&date=${day(d)}&pax=1`);
    assert.equal(r.status, 200);
    if (!r.body.outbound.length) {
      assert.ok(r.body.suggestions.outbound.length > 0);
      found = true;
    }
  }
  assert.ok(found);
  const sched = await c.get('/api/flights/schedule?segment=DOMESTIC');
  assert.ok(sched.body.routes.length >= 8);
  const board = await c.get('/api/flights/board?airport=ACC&type=departures');
  assert.equal(board.status, 200);
  const airports = await c.get('/api/flights/airports');
  assert.ok(airports.body.airports.find((a) => a.code === 'ACC').served);
});

test('Scenario 1.2: manage booking by PNR + surname and change date', async () => {
  const anon = client();
  assert.equal((await anon.get('/api/bookings/KWM7KS')).status, 404, 'no access without lookup');
  assert.equal((await anon.post('/api/bookings/lookup', { pnr: 'KWM7KS', surname: 'Owusu' })).status, 404);
  const look = await anon.post('/api/bookings/lookup', { pnr: 'kwm7ks', surname: 'mensah' });
  assert.equal(look.status, 200);
  const h = { 'X-Booking-Token': look.body.token };
  const b = await anon.get('/api/bookings/KWM7KS', h);
  assert.equal(b.status, 200);
  const segId = b.body.booking.segments[0].segmentId;
  const opts = await anon.get(`/api/bookings/KWM7KS/change-options?segmentId=${segId}`, h);
  assert.ok(opts.body.options.length > 0);
  assert.ok(opts.body.options.every((o) => o.feePerPax === 80), 'domestic change fee');
  const target = opts.body.options[1];
  const ch = await anon.post('/api/bookings/KWM7KS/change', { segmentId: segId, newFlightId: target.id }, h);
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  assert.equal(ch.body.booking.segments[0].id, target.id);
});

test('Scenario 1.3: live status shows delayed Lagos flight', async () => {
  const c = client();
  const flights = [];
  for (const d of [0, 1]) {
    const r = await c.get(`/api/flights/status?from=LOS&to=ACC&date=${day(d)}`);
    assert.equal(r.status, 200);
    flights.push(...r.body.flights);
  }
  assert.ok(flights.some((f) => f.live.delayMin > 0), 'seeded delay is visible');
});

test('Scenario 1.4: profile update re-encrypts passport', async () => {
  const c = client();
  await c.login(DEMO_ACCOUNTS.traveler);
  const r = await c.put('/api/profile', { name: 'Kwame Mensah', phone: '0244999888', passportNo: 'G7654321', passportExpiry: '2032-01-01', emergency: { name: 'Akosua', relation: 'Spouse', phone: '0209876543' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.passport, '•••••321');
  assert.equal(r.body.profile.phone, '0244999888');
  const doc = await c.get('/api/profile/travel-document');
  assert.equal(doc.body.passportNo, 'G7654321');
  assert.equal((await c.put('/api/profile/password', { currentPassword: 'wrong', newPassword: 'Newpass123' })).status, 401);
});

test('Scenario 1.5: cargo quote uses volumetric weight; request and track', async () => {
  const c = client();
  const r = await c.post('/api/cargo/quote', { origin: 'ACC', destination: 'TML', cargoType: 'GENERAL', pieces: 1, weightKg: 5, lengthCm: 100, widthCm: 60, heightCm: 60 });
  assert.equal(r.status, 200);
  assert.equal(r.body.quote.chargeableKg, 60);
  assert.equal(r.body.segment, 'DOMESTIC');
  const req = await c.post('/api/cargo', { origin: 'ACC', destination: 'TML', cargoType: 'GENERAL', pieces: 1, weightKg: 5, lengthCm: 50, widthCm: 40, heightCm: 30, shipperName: 'Kofi', shipperPhone: '0244111222', consigneeName: 'Ama', consigneePhone: '0244333444', description: 'Books' });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  const track = await c.get(`/api/cargo/track/${req.body.awb}`);
  assert.equal(track.body.shipment.status, 'PENDING');
  assert.equal(track.body.shipment.events.length, 1);
});

test('customer support ticket flow', async () => {
  const c = client();
  await c.login(DEMO_ACCOUNTS.traveler);
  const t = await c.post('/api/support', { category: 'BAGGAGE', subject: 'Extra bag', message: 'Can I add a second bag please?' });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const reply = await c.post(`/api/support/${t.body.ticket.ref}/messages`, { message: 'Thanks!' });
  assert.equal(reply.body.ticket.messages.length, 2);
  assert.ok((await c.get('/api/support')).body.tickets.length >= 1);
});

test('Staff scenarios 2.1–2.5 and RBAC', async () => {
  const staff = client();
  await staff.login(DEMO_ACCOUNTS.staff);
  // 2.1 support
  const list = await staff.get('/api/staff/support');
  assert.ok(list.body.tickets.some((x) => x.ref === 'SR-104233' && x.awaitingReply));
  const t = await staff.post('/api/staff/support/SR-104233/reply', { message: 'Economy: 1 × 20 kg checked, 7 kg cabin.', status: 'RESOLVED' });
  assert.equal(t.body.ticket.status, 'RESOLVED');
  // 2.2 gate
  const bk = await staff.get('/api/staff/bookings/KWM4LN');
  const code = bk.body.booking.passengers[0].tickets[0].ticketNo;
  const s1 = await staff.post('/api/staff/gate/scan', { code, override: true });
  assert.equal(s1.body.result, 'BOARDED');
  assert.equal((await staff.post('/api/staff/gate/scan', { code })).body.result, 'DUPLICATE');
  assert.equal((await staff.post('/api/staff/gate/scan', { code: `ADK1.${code}.0000000000000000` })).body.result, 'INVALID');
  // 2.3 cancel
  assert.equal((await staff.post('/api/staff/bookings/AMA3TK/cancel', { reason: 'ill' })).status, 400, 'identity must be verified');
  const cx = await staff.post('/api/staff/bookings/AMA3TK/cancel', { identityVerified: true, reason: 'Passenger unwell' });
  assert.equal(cx.body.booking.status, 'CANCELLED');
  assert.ok(cx.body.refund > 0);
  // 2.4 cargo
  const cg = await staff.get('/api/staff/cargo/839-20481157');
  const fit = cg.body.flightOptions.find((f) => f.fits);
  assert.ok((await staff.post('/api/staff/cargo/839-20481157/approve', { flightId: fit.id })).body.ok);
  assert.equal((await staff.post('/api/staff/cargo/839-20481157/advance', {})).body.status, 'RECEIVED');
  assert.ok((await staff.get('/api/staff/cargo')).body.shipments.length >= 3);
  // 2.5 re-route a passenger on the delayed flight
  const flights = (await staff.get('/api/staff/flights?back=1&ahead=72')).body.flights;
  const delayed = flights.find((f) => f.flightNo === 'AD201' && f.delayMin > 0);
  const man = await (async () => { const c = client(); await c.login(DEMO_ACCOUNTS.admin); return c.get(`/api/staff/flights/${delayed.id}/manifest`); })();
  assert.ok(man.body.passengers.length > 0);
  const pnr = man.body.passengers[0].pnr;
  const seg = (await staff.get(`/api/staff/bookings/${pnr}`)).body.booking.segments[0].segmentId;
  const ro = await staff.get(`/api/staff/bookings/${pnr}/reroute-options?segmentId=${seg}`);
  const rr = await staff.post(`/api/staff/bookings/${pnr}/reroute`, { segmentId: seg, newFlightId: ro.body.options[0].id });
  assert.equal(rr.status, 200, JSON.stringify(rr.body));
  assert.equal(rr.body.charged, 0);

  // Flight ops (Yaw has the "ops" permission)
  const ops = client();
  await ops.login({ email: 'yaw.darko@adinkra-air.test', password: 'Staff@2026' });
  const upd = await ops.put(`/api/staff/flights/${delayed.id}/ops`, { delayMin: 120, remarks: 'Weather' });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.equal(upd.body.flight.live.delayMin, 120);

  // RBAC: staff cannot reach admin; traveler cannot reach staff
  assert.equal((await staff.get('/api/admin/analytics')).status, 403);
  assert.equal((await staff.put('/api/staff/flights/1/ops', { delayMin: 5 })).status, 403, 'no ops permission');
  const trav = client();
  await trav.login(DEMO_ACCOUNTS.traveler);
  assert.equal((await trav.get('/api/staff/support')).status, 403);
  assert.equal((await client().get('/api/staff/support')).status, 401);
});

test('Admin scenarios 3.1–3.5', async () => {
  const a = client();
  await a.login(DEMO_ACCOUNTS.admin);
  // 3.1 new route goes live
  const r = await a.post('/api/admin/routes', { origin: 'ACC', destination: 'ABJ', flightNo: 'AD240', depTime: '08:45', durationMin: 65, basePrice: 1450, aircraft: 'Boeing 737-800', days: '1234567', generateDays: 14, returnFlight: { flightNo: 'AD241', depTime: '11:30' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.created[0].route.segment, 'REGIONAL');
  assert.ok(r.body.created[0].flights >= 14);
  const s = await client().get(`/api/flights/search?from=ACC&to=ABJ&date=${day(2)}&pax=1`);
  assert.equal(s.body.outbound.length, 1);
  const routes = await a.get('/api/admin/routes');
  const abj = routes.body.routes.find((x) => x.flightNo === 'AD240');
  const upd = await a.put(`/api/admin/routes/${abj.id}`, { basePrice: 1500, aircraft: 'ATR 72-600' });
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  assert.ok(upd.body.updatedFlights > 0);
  // 3.2 revenue analytics
  const an = await a.get('/api/admin/analytics?days=30&segment=INTERNATIONAL');
  assert.equal(an.status, 200, JSON.stringify(an.body));
  assert.ok(an.body.kpis.grossRevenue > 0);
  assert.ok(an.body.weekly.length > 0 && an.body.topRoutes.length > 0 && an.body.methods.length > 0);
  // 3.3 staff access
  const gateEmail = `gate.${RUN}@adinkra-air.test`;
  const u = await a.post('/api/admin/users', { name: 'New Gate Agent', email: gateEmail, role: 'staff', password: 'Welcome@2026', permissions: ['gate'] });
  assert.equal(u.status, 201, JSON.stringify(u.body));
  assert.equal((await a.get('/api/auth/me')).body.user.email, DEMO_ACCOUNTS.admin.email, 'admin is still signed in as themselves');
  const g = client();
  await g.login({ email: gateEmail, password: 'Welcome@2026' });
  assert.equal((await g.get('/api/staff/support')).status, 403);
  assert.equal((await g.get('/api/staff/flights')).status, 200);
  // Permission changes apply on the next request; the flight list needs gate or ops.
  assert.equal((await a.put(`/api/admin/users/${u.body.user.id}`, { permissions: ['support'] })).status, 200);
  assert.equal((await g.get('/api/staff/flights')).status, 403, 'support-only staff cannot list flights');
  assert.equal((await g.get('/api/staff/support')).status, 200);
  assert.deepEqual((await g.get('/api/auth/me')).body.user.permissions, ['support']);
  const users = await a.get('/api/admin/users?q=gate');
  assert.ok(users.body.users.some((x) => x.email === gateEmail));
  // Deactivating an account locks it out on its next request, even with a live Neon Auth session.
  assert.equal((await a.put(`/api/admin/users/${u.body.user.id}`, { active: false })).status, 200);
  assert.equal((await g.get('/api/staff/flights')).status, 401);
  assert.equal((await client().post('/api/auth/login', { email: gateEmail, password: 'Welcome@2026' })).status, 403);
  // 3.4 occupancy
  const oc = await a.get('/api/admin/occupancy?window=past30');
  assert.ok(oc.body.routes.length > 0 && oc.body.overall > 0);
  // 3.5 security
  const sec = await a.get('/api/admin/security');
  assert.equal(sec.status, 200, JSON.stringify(sec.body));
  assert.ok(sec.body.checks.every((c) => c.ok), JSON.stringify(sec.body.checks.filter((c) => !c.ok)));
  const audit = await a.get('/api/admin/audit?severity=high');
  assert.ok(audit.body.events.some((e) => e.action === 'rbac.user_create'));
  const set = await a.put('/api/admin/settings', { booking_hold_minutes: 25 });
  assert.equal(set.body.settings.booking_hold_minutes, '25');
  const purge = await a.post('/api/admin/retention/purge');
  assert.equal(purge.status, 200);
});

test('Realtime: sealed live queries for the board and status pages', { skip: !process.env.NEON_REALTIME_SECRET && 'NEON_REALTIME_SECRET not set' }, async () => {
  const c = client();
  const b1 = await c.get('/api/live/board?airport=ACC&type=departures');
  assert.equal(b1.status, 200, JSON.stringify(b1.body));
  assert.match(b1.body.url, /^wss?:\/\//);
  assert.ok(b1.body.sealed.capability && b1.body.sealed.queryFingerprint);
  assert.ok(b1.body.sealed.expiresAt > Date.now());
  // Renewal must seal the identical query (same fingerprint) or the subscription would be dropped.
  const b2 = await c.get('/api/live/board?airport=ACC&type=departures');
  assert.equal(b2.body.sealed.queryFingerprint, b1.body.sealed.queryFingerprint);
  const arr = await c.get('/api/live/board?airport=ACC&type=arrivals');
  assert.notEqual(arr.body.sealed.queryFingerprint, b1.body.sealed.queryFingerprint);
  assert.equal((await c.get(`/api/live/status?flightNo=AD201&date=${day(0)}`)).status, 200);
  assert.equal((await c.get(`/api/live/status?from=LOS&to=ACC&date=${day(0)}`)).status, 200);
  assert.equal((await c.get('/api/live/status?flightNo=bad')).status, 400);
});
