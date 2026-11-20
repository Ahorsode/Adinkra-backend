// End-to-end API tests covering the assignment's user scenarios.
// Runs the Hono app against a throw-away in-memory Postgres (PGlite): `npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATA_KEY ||= crypto.randomBytes(32).toString('hex');
process.env.HMAC_KEY ||= crypto.randomBytes(32).toString('hex');

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

/** Minimal client that keeps the session cookie, like a browser. */
function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await app.fetch(new Request(base + url, {
      method,
      headers: { 'X-Requested-With': 'fetch', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }));
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
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

test('registration validates Ghana Card and stores it encrypted', async () => {
  const c = client();
  const bad = await c.post('/api/auth/register', { name: 'Test User', email: 't@example.com', phone: '0241112222', nationalId: '123', password: 'abc12345' });
  assert.equal(bad.status, 400);
  const ok = await c.post('/api/auth/register', { name: 'Test User', email: 't@example.com', phone: '0241112222', nationalId: 'GHA-123456789-0', password: 'abc12345' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+; Secure/);
  const row = await one("SELECT national_id_enc, password_hash FROM users WHERE email = 't@example.com'");
  assert.match(row.national_id_enc, /^v1:/);
  assert.ok(!row.national_id_enc.includes('123456789'));
  assert.match(row.password_hash, /^pbkdf2\$100000\$/);
  const me = await c.get('/api/auth/me');
  assert.equal(me.body.user.email, 't@example.com');
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
  const u = await a.post('/api/admin/users', { name: 'New Gate Agent', email: 'gate@adinkra-air.test', role: 'staff', password: 'Welcome@2026', permissions: ['gate'] });
  assert.equal(u.status, 201);
  const g = client();
  await g.login({ email: 'gate@adinkra-air.test', password: 'Welcome@2026' });
  assert.equal((await g.get('/api/staff/support')).status, 403);
  assert.equal((await g.get('/api/staff/flights')).status, 200);
  const users = await a.get('/api/admin/users?q=gate');
  assert.ok(users.body.users.some((x) => x.email === 'gate@adinkra-air.test'));
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
