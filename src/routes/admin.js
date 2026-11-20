import { Hono } from 'hono';
import { h, toId } from '../http.js';
import { one, all, run, insert, tx, nowIso, allSettings, SETTING_KEYS } from '../db.js';
import {
  bad, HttpError, requireRole, hashPassword, passwordProblem, audit, keyFingerprint, decrypt, PBKDF2_ITERATIONS,
} from '../security.js';
import { AIRCRAFT, seatLayout, segmentFor, STAFF_PERMISSIONS } from '../domain.js';
import { AIRPORT, takenSeatsFor } from '../services.js';
import { generateFlights } from '../schedule.js';
import { EMAIL_RE } from './auth.js';

const router = new Hono();
router.use('*', requireRole('admin'));

const DAY = 86400000;
const SEGMENTS = ['DOMESTIC', 'REGIONAL', 'INTERNATIONAL'];

router.get('/meta', (c) => c.json({
  airports: Object.values(AIRPORT),
  aircraft: Object.entries(AIRCRAFT).map(([name, a]) => ({ name, seats: seatLayout(name).capacity, cargoKg: a.cargoKg })),
  permissions: STAFF_PERMISSIONS,
}));

// ---------------- Analytics ----------------
// Aggregates scan tens of thousands of rows, so results are cached for a minute (per Worker isolate).
const analyticsCache = new Map();
const CACHE_MS = 60000;

router.get('/analytics', h(async (req, c) => {
  const days = [30, 90, 180, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 90;
  const seg = SEGMENTS.includes(req.query.segment) ? req.query.segment : null;
  const key = `${days}|${seg}`;
  const hit = analyticsCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return c.json({ ...hit.data, cachedAt: new Date(hit.at).toISOString() });
  const data = await computeAnalytics(days, seg);
  analyticsCache.set(key, { at: Date.now(), data });
  return c.json({ ...data, cachedAt: new Date().toISOString() });
}));

export async function computeAnalytics(days, seg) {
  const since = new Date(Date.now() - days * DAY).toISOString();
  const segSql = seg ? 'AND b.segment = ?' : '';
  const segP = seg ? [seg] : [];

  const [monthly, refundsMonthly, cargoRow, counts, flownRow, weekly, topRoutes, methods] = await Promise.all([
    all(
      `SELECT substr(p.created_at, 1, 7) AS month, b.segment, SUM(p.amount) AS amount FROM payments p JOIN bookings b ON b.id = p.booking_id
       WHERE p.status = 'SUCCESS' AND p.created_at >= ? ${segSql} GROUP BY 1, b.segment ORDER BY 1`,
      since, ...segP,
    ),
    all(
      `SELECT substr(r.created_at, 1, 7) AS month, SUM(r.amount) AS amount FROM refunds r JOIN bookings b ON b.id = r.booking_id
       WHERE r.created_at >= ? ${segSql} GROUP BY 1`,
      since, ...segP,
    ),
    one(
      `SELECT COALESCE(SUM(p.amount), 0) AS s FROM payments p JOIN cargo c ON c.id = p.cargo_id
       JOIN routes r ON r.origin = c.origin AND r.destination = c.destination
       WHERE p.status = 'SUCCESS' AND p.created_at >= ? ${seg ? 'AND r.segment = ?' : ''}`,
      since, ...segP,
    ),
    one(
      `SELECT COUNT(*) AS bookings, COUNT(*) FILTER (WHERE b.status = 'CANCELLED') AS cancelled,
         (SELECT COUNT(*) FROM tickets t JOIN passengers p ON p.id = t.passenger_id JOIN bookings b2 ON b2.id = p.booking_id
          WHERE b2.created_at >= ? AND b2.status = 'CONFIRMED' ${seg ? 'AND b2.segment = ?' : ''}) AS tickets
       FROM bookings b WHERE b.created_at >= ? AND b.status IN ('CONFIRMED','CANCELLED') ${segSql}`,
      since, ...segP, since, ...segP,
    ),
    one(
      `SELECT COUNT(*) AS n FROM flights f JOIN booking_flights bf ON bf.flight_id = f.id JOIN tickets t ON t.booking_flight_id = bf.id
       JOIN routes r ON r.id = f.route_id WHERE t.status = 'BOARDED' AND f.departure >= ? ${seg ? 'AND r.segment = ?' : ''}`,
      since, ...segP,
    ),
    all(
      `SELECT to_char(b.created_at::timestamptz AT TIME ZONE 'UTC', 'IYYY-IW') AS week, MIN(substr(b.created_at, 1, 10)) AS start, COUNT(t.id) AS tickets
       FROM bookings b JOIN passengers p ON p.booking_id = b.id JOIN tickets t ON t.passenger_id = p.id
       WHERE b.created_at >= ? AND b.status IN ('CONFIRMED','CANCELLED') ${segSql} GROUP BY 1 ORDER BY 1`,
      since, ...segP,
    ),
    all(
      `SELECT r.origin, r.destination, r.segment, SUM(p.amount) AS revenue, COUNT(DISTINCT b.id) AS bookings
       FROM payments p JOIN bookings b ON b.id = p.booking_id
       JOIN booking_flights bf ON bf.booking_id = b.id AND bf.direction = 'OUT'
       JOIN flights f ON f.id = bf.flight_id JOIN routes r ON r.id = f.route_id
       WHERE p.status = 'SUCCESS' AND p.created_at >= ? ${segSql} GROUP BY r.id ORDER BY revenue DESC LIMIT 8`,
      since, ...segP,
    ),
    all(
      `SELECT p.method, COALESCE(p.provider, '') AS provider, COUNT(*) AS n, SUM(p.amount) AS amount FROM payments p JOIN bookings b ON b.id = p.booking_id
       WHERE p.status = 'SUCCESS' AND p.created_at >= ? ${segSql} GROUP BY p.method, p.provider ORDER BY 4 DESC`,
      since, ...segP,
    ),
  ]);
  const gross = monthly.reduce((s, m) => s + m.amount, 0);
  const refunds = refundsMonthly.reduce((s, m) => s + m.amount, 0);
  const months = [...new Set(monthly.map((m) => m.month))];
  return {
    days, segment: seg,
    kpis: {
      grossRevenue: gross, refunds, netRevenue: gross - refunds, cargoRevenue: cargoRow.s,
      bookings: counts.bookings || 0, cancelled: counts.cancelled || 0, ticketsSold: counts.tickets || 0,
      passengersFlown: flownRow.n, avgTicket: counts.tickets ? (gross - refunds) / counts.tickets : 0,
    },
    monthly: months.map((m) => ({
      month: m,
      ...Object.fromEntries(SEGMENTS.map((s) => [s, monthly.find((x) => x.month === m && x.segment === s)?.amount || 0])),
      refunds: refundsMonthly.find((x) => x.month === m)?.amount || 0,
    })),
    weekly,
    topRoutes: topRoutes.map((r) => ({ ...r, label: `${AIRPORT[r.origin].city} → ${AIRPORT[r.destination].city}` })),
    methods,
  };
}

// ---------------- Seat occupancy ----------------
router.get('/occupancy', h(async (req, c) => {
  const window = req.query.window === 'next30' ? 'next30' : 'past30';
  const seg = SEGMENTS.includes(req.query.segment) ? req.query.segment : null;
  const [from, to] = window === 'next30'
    ? [nowIso(), new Date(Date.now() + 30 * DAY).toISOString()]
    : [new Date(Date.now() - 30 * DAY).toISOString(), nowIso()];
  const [flights, routeRows] = await Promise.all([
    all(
      `SELECT f.id, f.route_id, f.aircraft, f.departure,
         (SELECT COUNT(*) FROM tickets t JOIN booking_flights bf ON bf.id = t.booking_flight_id WHERE bf.flight_id = f.id AND t.status != 'CANCELLED') AS sold
       FROM flights f JOIN routes r ON r.id = f.route_id
       WHERE f.departure >= ? AND f.departure < ? AND f.status != 'CANCELLED' ${seg ? 'AND r.segment = ?' : ''}`,
      from, to, ...(seg ? [seg] : []),
    ),
    all('SELECT * FROM routes'),
  ]);
  const routes = Object.fromEntries(routeRows.map((r) => [r.id, r]));
  const agg = {};
  for (const f of flights) {
    const cap = seatLayout(f.aircraft).capacity.total;
    const a = (agg[f.route_id] ||= { flights: 0, seats: 0, sold: 0, min: 1, max: 0 });
    a.flights++;
    a.seats += cap;
    a.sold += f.sold;
    a.min = Math.min(a.min, f.sold / cap);
    a.max = Math.max(a.max, f.sold / cap);
  }
  const rows = Object.entries(agg).map(([id, a]) => {
    const r = routes[id];
    const load = a.seats ? a.sold / a.seats : 0;
    let advice = 'Healthy load – keep current capacity';
    if (window === 'past30') {
      if (load >= 0.85) advice = 'High demand – consider a larger aircraft or extra frequency';
      else if (load < 0.5) advice = 'Low demand – consider a smaller aircraft or fewer weekly flights';
    } else if (load < 0.2) advice = 'Bookings building slowly – consider a fare promotion';
    return {
      routeId: r.id, flightNo: r.flight_no, origin: r.origin, destination: r.destination, segment: r.segment,
      label: `${AIRPORT[r.origin].city} → ${AIRPORT[r.destination].city}`, aircraft: r.aircraft,
      flights: a.flights, seats: a.seats, sold: a.sold, load, minLoad: a.min, maxLoad: a.max, advice,
    };
  }).sort((x, y) => y.load - x.load);
  const tot = rows.reduce((s, r) => ({ seats: s.seats + r.seats, sold: s.sold + r.sold }), { seats: 0, sold: 0 });
  const bySegment = SEGMENTS.map((s) => {
    const rs = rows.filter((r) => r.segment === s);
    const seats = rs.reduce((x, r) => x + r.seats, 0);
    return { segment: s, seats, sold: rs.reduce((x, r) => x + r.sold, 0), load: seats ? rs.reduce((x, r) => x + r.sold, 0) / seats : 0 };
  }).filter((s) => s.seats);
  return c.json({ window, segment: seg, overall: tot.seats ? tot.sold / tot.seats : 0, bySegment, routes: rows });
}));

// ---------------- Routes & schedules ----------------
const routeView = (r) => ({
  id: r.id, flightNo: r.flight_no, origin: r.origin, destination: r.destination, segment: r.segment,
  originCity: AIRPORT[r.origin]?.city, destinationCity: AIRPORT[r.destination]?.city,
  basePrice: r.base_price, durationMin: r.duration_min, aircraft: r.aircraft, depTime: r.dep_time, days: r.days,
  active: !!r.active, createdAt: r.created_at, upcoming: r.upcoming,
});

router.get('/routes', h(async (_req, c) => {
  const rows = await all(
    `SELECT r.*, (SELECT COUNT(*) FROM flights f WHERE f.route_id = r.id AND f.departure > ?) AS upcoming FROM routes r ORDER BY r.segment, r.flight_no`,
    nowIso(),
  );
  return c.json({ routes: rows.map(routeView) });
}));

async function validateRouteInput({ flightNo, depTime }) {
  if (!/^AD\d{3,4}$/.test(flightNo)) throw bad('Flight number must look like AD240');
  if (await one('SELECT 1 FROM routes WHERE flight_no = ?', flightNo)) throw bad(`Flight number ${flightNo} is already in use`);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(depTime))) throw bad('Departure time must be HH:MM (GMT)');
}

router.post('/routes', h(async (req, c) => {
  const b = req.body || {};
  const origin = String(b.origin || '').toUpperCase();
  const destination = String(b.destination || '').toUpperCase();
  if (!AIRPORT[origin] || !AIRPORT[destination] || origin === destination) throw bad('Choose two different airports');
  const segment = segmentFor(origin, destination);
  const flightNo = String(b.flightNo || '').toUpperCase().trim();
  await validateRouteInput({ flightNo, depTime: b.depTime });
  if (await one('SELECT 1 FROM routes WHERE origin = ? AND destination = ?', origin, destination)) throw bad('This route already exists – edit it instead');
  const duration = Math.round(Number(b.durationMin));
  if (!(duration >= 20 && duration <= 960)) throw bad('Flight duration must be 20–960 minutes');
  const price = Number(b.basePrice);
  if (!(price >= 50 && price <= 100000)) throw bad('Base fare must be between GHS 50 and 100,000');
  if (!AIRCRAFT[b.aircraft]) throw bad('Choose an aircraft type');
  const days = [...new Set(String(b.days || '').replace(/[^1-7]/g, ''))].sort().join('');
  if (!days) throw bad('Select at least one operating day');
  const genDays = Math.max(7, Math.min(120, Number(b.generateDays) || 60));
  const ret = b.returnFlight && b.returnFlight.flightNo ? {
    flightNo: String(b.returnFlight.flightNo).toUpperCase().trim(), depTime: b.returnFlight.depTime,
  } : null;
  if (ret) {
    await validateRouteInput(ret);
    if (ret.flightNo === flightNo) throw bad('Return flight needs its own flight number');
  }
  const created = await tx(async () => {
    const make = async (fn, o, d, t) => {
      const id = await insert(
        'INSERT INTO routes (flight_no, origin, destination, segment, base_price, duration_min, aircraft, dep_time, days, active) VALUES (?,?,?,?,?,?,?,?,?,?)',
        fn, o, d, segment, price, duration, b.aircraft, t, days, b.publish === false ? 0 : 1,
      );
      const route = await one('SELECT * FROM routes WHERE id = ?', id);
      return { route: routeView(route), flights: (await generateFlights(route, 0, genDays)).length };
    };
    const out = [await make(flightNo, origin, destination, b.depTime)];
    if (ret) out.push(await make(ret.flightNo, destination, origin, ret.depTime));
    return out;
  });
  await audit(req, 'route.create', { target: created.map((x) => x.route.flightNo).join(','), details: { origin, destination, price, days, published: b.publish !== false }, severity: 'warn' });
  return c.json({ created }, 201);
}));

router.put('/routes/:id', h(async (req, c) => {
  const r = await one('SELECT * FROM routes WHERE id = ?', toId(req.params.id));
  if (!r) throw new HttpError(404, 'Route not found');
  const b = req.body || {};
  const price = b.basePrice != null ? Number(b.basePrice) : r.base_price;
  if (!(price >= 50 && price <= 100000)) throw bad('Base fare must be between GHS 50 and 100,000');
  const aircraft = b.aircraft || r.aircraft;
  if (!AIRCRAFT[aircraft]) throw bad('Unknown aircraft');
  const active = b.active != null ? (b.active ? 1 : 0) : r.active;
  let skipped = 0;
  let updated = 0;
  await tx(async () => {
    await run('UPDATE routes SET base_price = ?, aircraft = ?, active = ? WHERE id = ?', price, aircraft, active, r.id);
    const future = await all('SELECT id, aircraft FROM flights WHERE route_id = ? AND departure > ?', r.id, new Date(Date.now() + 6 * 3600000).toISOString());
    const layout = seatLayout(aircraft);
    const swapping = future.filter((f) => f.aircraft !== aircraft);
    const taken = await takenSeatsFor(swapping.map((f) => f.id));
    const changeAircraft = [];
    const updatePrice = [];
    for (const f of future) {
      if (f.aircraft !== aircraft) {
        const conflict = [...taken.get(f.id)].some((s) => !layout.tierOf.has(s));
        if (conflict) { skipped++; continue; }
        changeAircraft.push(f.id);
      }
      updatePrice.push(f.id);
      updated++;
    }
    const ids = (list) => `{${list.join(',')}}`;
    if (changeAircraft.length) {
      await run('UPDATE flights SET aircraft = ?, cargo_capacity_kg = ? WHERE id = ANY(?::int[])', aircraft, AIRCRAFT[aircraft].cargoKg, ids(changeAircraft));
    }
    if (updatePrice.length) await run('UPDATE flights SET base_price = ? WHERE id = ANY(?::int[])', price, ids(updatePrice));
  });
  await audit(req, 'route.update', { target: r.flight_no, details: { price, aircraft, active: !!active, updated, skipped }, severity: 'warn' });
  return c.json({ route: routeView(await one('SELECT * FROM routes WHERE id = ?', r.id)), updatedFlights: updated, skippedFlights: skipped });
}));

router.post('/routes/:id/extend', h(async (req, c) => {
  const r = await one('SELECT * FROM routes WHERE id = ?', toId(req.params.id));
  if (!r) throw new HttpError(404, 'Route not found');
  const n = (await generateFlights(r, 0, Math.max(7, Math.min(120, Number(req.body?.days) || 60)))).length;
  await audit(req, 'route.extend', { target: r.flight_no, details: { added: n } });
  return c.json({ added: n });
}));

// ---------------- Users & RBAC ----------------
const userView = (u) => ({
  id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, permissions: JSON.parse(u.permissions),
  active: !!u.active, createdAt: u.created_at, lastLogin: u.last_login,
});

router.get('/users', h(async (req, c) => {
  const role = ['traveler', 'staff', 'admin'].includes(req.query.role) ? req.query.role : null;
  const q = String(req.query.q || '').trim().replace(/[\\%_]/g, (m) => `\\${m}`);
  const [rows, countRows] = await Promise.all([
    all(
      `SELECT * FROM users WHERE 1 = 1 ${role ? 'AND role = ?' : ''} ${q ? 'AND (name ILIKE ? OR email ILIKE ?)' : ''}
       ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'staff' THEN 1 ELSE 2 END, name LIMIT 300`,
      ...(role ? [role] : []), ...(q ? [`%${q}%`, `%${q}%`] : []),
    ),
    all('SELECT role, COUNT(*) AS n FROM users GROUP BY role'),
  ]);
  return c.json({ users: rows.map(userView), counts: Object.fromEntries(countRows.map((r) => [r.role, r.n])) });
}));

const cleanPerms = (p) => (Array.isArray(p) ? [...new Set(p.filter((x) => STAFF_PERMISSIONS[x]))] : []);

router.post('/users', h(async (req, c) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = String(b.email || '').trim().toLowerCase();
  const role = ['staff', 'admin'].includes(b.role) ? b.role : null;
  if (name.length < 2) throw bad('Enter the staff member’s name');
  if (!EMAIL_RE.test(email)) throw bad('Enter a valid email');
  if (!role) throw bad('Role must be staff or admin');
  const err = await passwordProblem(b.password);
  if (err) throw bad(`Temporary password: ${err}`);
  if (await one('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'A user with that email already exists');
  const perms = role === 'admin' ? Object.keys(STAFF_PERMISSIONS) : cleanPerms(b.permissions);
  if (role === 'staff' && !perms.length) throw bad('Give the staff member at least one permission');
  const id = await insert(
    'INSERT INTO users (name, email, phone, password_hash, role, permissions) VALUES (?,?,?,?,?,?)',
    name, email, String(b.phone || '').slice(0, 20) || null, await hashPassword(b.password), role, JSON.stringify(perms),
  );
  await audit(req, 'rbac.user_create', { target: email, details: { role, perms }, severity: 'high' });
  return c.json({ user: userView(await one('SELECT * FROM users WHERE id = ?', id)) }, 201);
}));

router.put('/users/:id', h(async (req, c) => {
  const u = await one('SELECT * FROM users WHERE id = ?', toId(req.params.id));
  if (!u) throw new HttpError(404, 'User not found');
  const b = req.body || {};
  const role = b.role && ['traveler', 'staff', 'admin'].includes(b.role) ? b.role : u.role;
  const active = b.active != null ? (b.active ? 1 : 0) : u.active;
  if (u.id === req.user.id && (role !== 'admin' || !active)) throw bad('You cannot remove your own admin access');
  const perms = role === 'admin' ? Object.keys(STAFF_PERMISSIONS) : role === 'traveler' ? [] : b.permissions ? cleanPerms(b.permissions) : JSON.parse(u.permissions);
  await run('UPDATE users SET role = ?, permissions = ?, active = ? WHERE id = ?', role, JSON.stringify(perms), active, u.id);
  if (!active) await run('DELETE FROM sessions WHERE user_id = ?', u.id);
  await audit(req, 'rbac.user_update', { target: u.email, details: { from: { role: u.role, perms: JSON.parse(u.permissions), active: !!u.active }, to: { role, perms, active: !!active } }, severity: 'high' });
  return c.json({ user: userView(await one('SELECT * FROM users WHERE id = ?', u.id)) });
}));

// ---------------- Security & data protection ----------------
router.get('/security', h(async (_req, c) => {
  const day = new Date(Date.now() - DAY).toISOString();
  const encFields = await Promise.all([
    ['users', 'national_id_enc', 'users.national_id'],
    ['users', 'passport_enc', 'users.passport'],
    ['passengers', 'passport_enc', 'passengers.passport'],
  ].map(async ([table, col, field]) => {
    // Table/column names are constants above, never user input.
    const [{ n: records }, vals] = await Promise.all([
      one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} IS NOT NULL`),
      // Self-test: decrypt the most recent 2,000 values.
      all(`SELECT ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL ORDER BY id DESC LIMIT 2000`),
    ]);
    let ok = 0;
    let failed = 0;
    for (const { v } of vals) {
      try { if (v.startsWith('v1:') && decrypt(v) != null) ok++; else failed++; } catch { failed++; }
    }
    return { field, records, verified: ok, failures: failed };
  }));
  const [settings, sevRows, failed24, admins, legacyPwd, cardNumbers, activeSessions] = await Promise.all([
    allSettings(),
    all('SELECT severity, COUNT(*) AS n FROM audit_log WHERE created_at >= ? GROUP BY severity', day),
    one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login_failed' AND created_at >= ?", day),
    one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1"),
    one("SELECT COUNT(*) AS n FROM users WHERE password_hash NOT LIKE 'pbkdf2$%'"),
    one("SELECT COUNT(*) AS n FROM payments WHERE account_masked ~ '[0-9]{8}'"),
    one('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', nowIso()),
  ]);
  const checks = [
    { label: 'Personal identifiers (Ghana Card, passports) encrypted at rest with AES-256-GCM', ok: encFields.every((f) => f.failures === 0) },
    { label: 'All passwords stored as salted PBKDF2-SHA256 hashes', ok: legacyPwd.n === 0 },
    { label: 'Role-based access control enforced on staff and admin APIs', ok: true },
    { label: `Password policy: minimum ${settings.password_min_length} characters, letters + digits`, ok: Number(settings.password_min_length) >= 8 },
    { label: `Sessions expire after ${settings.session_timeout_hours} hours (HttpOnly, SameSite=Strict cookie)`, ok: Number(settings.session_timeout_hours) <= 12 },
    { label: 'Staff see masked passport numbers unless access is justified and logged', ok: settings.mask_pii_for_staff === '1' },
    { label: `Audit and notification data retained for ${settings.data_retention_days} days`, ok: Number(settings.data_retention_days) <= 730 },
    { label: 'Card numbers never stored (only brand + last 4 digits kept)', ok: cardNumbers.n === 0 },
    { label: 'At least two active administrators (no single point of failure)', ok: admins.n >= 2 },
  ];
  return c.json({
    encryption: {
      algorithm: 'AES-256-GCM (96-bit IV, 128-bit auth tag)', keyFingerprint: keyFingerprint(), fields: encFields,
      passwordHashing: `PBKDF2-SHA256 (${PBKDF2_ITERATIONS.toLocaleString('en-US')} iterations), 16-byte salt`,
    },
    stats: {
      activeSessions: activeSessions.n,
      failedLogins24h: failed24.n, events24h: Object.fromEntries(sevRows.map((r) => [r.severity, r.n])), admins: admins.n,
    },
    checks, settings,
  });
}));

router.get('/audit', h(async (req, c) => {
  const sev = ['info', 'warn', 'high'].includes(req.query.severity) ? req.query.severity : null;
  const action = String(req.query.action || '').replace(/[^a-z_.]/g, '').replace(/_/g, '\\_');
  const rows = await all(
    `SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE 1 = 1
     ${sev ? 'AND a.severity = ?' : ''} ${action ? 'AND a.action LIKE ?' : ''} ORDER BY a.created_at DESC LIMIT 300`,
    ...(sev ? [sev] : []), ...(action ? [`${action}%`] : []),
  );
  return c.json({ events: rows.map((r) => ({ id: r.id, at: r.created_at, user: r.email, action: r.action, target: r.target, details: r.details, severity: r.severity, ip: r.ip })) });
}));

router.put('/settings', h(async (req, c) => {
  const b = req.body || {};
  const rules = {
    session_timeout_hours: [1, 72], password_min_length: [8, 64], booking_hold_minutes: [5, 120],
    data_retention_days: [30, 3650], max_login_attempts: [3, 20],
  };
  const changes = {};
  for (const key of SETTING_KEYS) {
    if (b[key] == null) continue;
    let v = String(b[key]);
    if (key === 'mask_pii_for_staff') v = v === '1' || v === 'true' ? '1' : '0';
    else {
      const n = Math.round(Number(v));
      const [min, max] = rules[key];
      if (!(n >= min && n <= max)) throw bad(`${key.replace(/_/g, ' ')} must be between ${min} and ${max}`);
      v = String(n);
    }
    changes[key] = v;
  }
  for (const [key, v] of Object.entries(changes)) {
    await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, v);
  }
  await audit(req, 'security.settings_update', { details: changes, severity: 'high' });
  return c.json({ settings: await allSettings() });
}));

router.post('/retention/purge', h(async (req, c) => {
  const days = Number((await allSettings()).data_retention_days);
  const cutoff = new Date(Date.now() - days * DAY).toISOString();
  const r = await tx(async () => ({
    auditEvents: (await run('DELETE FROM audit_log WHERE created_at < ?', cutoff)).changes,
    notifications: (await run('DELETE FROM notifications WHERE created_at < ?', cutoff)).changes,
    sessions: (await run('DELETE FROM sessions WHERE expires_at < ?', nowIso())).changes,
  }));
  await run('DELETE FROM rate_limits WHERE until_ms < ?', Date.now());
  await audit(req, 'security.retention_purge', { details: { ...r, cutoff }, severity: 'warn' });
  return c.json({ purged: r, cutoff });
}));

export default router;
