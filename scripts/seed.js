// Creates the schema and loads demo data into Postgres (Neon or local).
//
//   DATABASE_URL=<Neon direct connection string> npm run db:seed     # only if the database is empty
//   DATABASE_URL=... npm run db:reset                                # drop everything and re-seed
//
// Needs DATA_KEY and HMAC_KEY in the environment (the SAME values as the Worker secrets), because
// passports and Ghana Card numbers are encrypted with DATA_KEY before they are stored.
//
// The data is built in memory and bulk-inserted, so seeding Neon over the network takes about a minute.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, setDefaultDb, insertMany, one, all } from '../src/db.js';
import { AIRPORTS, AIRCRAFT, seatLayout, fareFor, taxesFor, STAFF_PERMISSIONS, cargoQuote } from '../src/domain.js';
import { hashPassword, encrypt } from '../src/security.js';
import { flightRows, FLIGHT_COLS } from '../src/schedule.js';
import { AIRLINE } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(here, '..', 'db', 'schema.sql'), 'utf8');

// Demo accounts (also documented in the README).
export const DEMO_ACCOUNTS = {
  admin: { name: 'Dr. Kojo Addo', email: 'kojo.addo@adinkra-air.test', password: 'Admin@2026' },
  admin2: { name: 'Efua Asante (System Administrator)', email: 'sysadmin@adinkra-air.test', password: 'Admin@2026' },
  staff: { name: 'Abena Ofori', email: 'abena.ofori@adinkra-air.test', password: 'Staff@2026' },
  traveler: { name: 'Kwame Mensah', email: 'kwame.mensah@example.com', password: 'Traveler@2026' },
};

// [flightNo, from, to, depTime GMT, minutes, base fare GHS, aircraft, ISO weekdays]
const ROUTES = [
  ['AD100', 'ACC', 'KMS', '06:30', 50, 450, 'ATR 72-600', '1234567'],
  ['AD101', 'KMS', 'ACC', '08:10', 50, 450, 'ATR 72-600', '1234567'],
  ['AD110', 'ACC', 'TML', '07:15', 75, 650, 'ATR 72-600', '1234567'],
  ['AD111', 'TML', 'ACC', '09:40', 75, 650, 'ATR 72-600', '1234567'],
  ['AD120', 'ACC', 'TKD', '16:00', 40, 400, 'ATR 72-600', '12345'],
  ['AD121', 'TKD', 'ACC', '17:30', 40, 400, 'ATR 72-600', '12345'],
  ['AD130', 'ACC', 'NYI', '11:00', 55, 500, 'ATR 72-600', '135'],
  ['AD131', 'NYI', 'ACC', '12:45', 55, 500, 'ATR 72-600', '135'],
  ['AD200', 'ACC', 'LOS', '09:30', 70, 1650, 'Boeing 737-800', '1234567'],
  ['AD201', 'LOS', 'ACC', '12:30', 70, 1650, 'Boeing 737-800', '1234567'],
  ['AD220', 'ACC', 'LFW', '15:00', 35, 950, 'Boeing 737-800', '246'],
  ['AD221', 'LFW', 'ACC', '16:30', 35, 950, 'Boeing 737-800', '246'],
  ['AD230', 'ACC', 'DSS', '10:00', 255, 3200, 'Boeing 737-800', '25'],
  ['AD231', 'DSS', 'ACC', '15:30', 255, 3200, 'Boeing 737-800', '25'],
  ['AD300', 'ACC', 'LHR', '22:30', 405, 9800, 'Boeing 787-9', '12457'],
  ['AD301', 'LHR', 'ACC', '11:00', 405, 9800, 'Boeing 787-9', '13568'],
  ['AD310', 'ACC', 'JFK', '23:00', 660, 12500, 'Boeing 787-9', '136'],
  ['AD311', 'JFK', 'ACC', '18:00', 630, 12500, 'Boeing 787-9', '247'],
  ['AD320', 'ACC', 'DXB', '20:00', 450, 8200, 'Boeing 787-9', '246'],
  ['AD321', 'DXB', 'ACC', '08:30', 480, 8200, 'Boeing 787-9', '357'],
  ['AD330', 'ACC', 'JNB', '12:00', 360, 6900, 'Boeing 787-9', '25'],
  ['AD331', 'JNB', 'ACC', '09:00', 360, 6900, 'Boeing 787-9', '36'],
];

const GH = ['ACC', 'KMS', 'TML', 'TKD', 'NYI'];
const WA = ['LOS', 'LFW', 'DSS', 'ABJ', 'ABV', 'OUA', 'FNA', 'ROB', 'COO'];
const segOf = (o, d) => {
  const gh = (c) => GH.includes(c);
  const wa = (c) => WA.includes(c) || gh(c);
  if (gh(o) && gh(d)) return 'DOMESTIC';
  if (wa(o) && wa(d)) return 'REGIONAL';
  return 'INTERNATIONAL';
};

const FIRST = ['Kwame', 'Ama', 'Kofi', 'Akosua', 'Yaw', 'Abena', 'Kwabena', 'Adwoa', 'Kwaku', 'Afua', 'Kojo', 'Efua', 'Kwesi', 'Esi', 'Yaa',
  'Nana', 'Selorm', 'Delali', 'Elikem', 'Sena', 'Fiifi', 'Ekow', 'Mawuli', 'Dzifa', 'Ibrahim', 'Fatima', 'Abdul', 'Amina', 'Chinedu',
  'Ngozi', 'Tunde', 'Aisha', 'Moussa', 'Aminata', 'James', 'Grace', 'Daniel', 'Sarah', 'Michael', 'Emmanuel', 'Priscilla', 'Samuel'];
const LAST = ['Mensah', 'Asante', 'Owusu', 'Boateng', 'Osei', 'Agyeman', 'Appiah', 'Darko', 'Ofori', 'Amoah', 'Addo', 'Quaye', 'Tetteh',
  'Annan', 'Acheampong', 'Badu', 'Ansah', 'Frimpong', 'Gyamfi', 'Nkrumah', 'Danso', 'Sarpong', 'Agbeko', 'Ahorsode', 'Katey', 'Jimah',
  'Okang', 'Asenso', 'Yeboah', 'Adjei', 'Okafor', 'Adeyemi', 'Diallo', 'Traoré', 'Koné', 'Smith', 'Williams', 'Johnson'];

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TABLES = ['rate_limits', 'settings', 'audit_log', 'notifications', 'ticket_messages', 'support_tickets', 'cargo_events', 'refunds',
  'payments', 'cargo', 'tickets', 'passengers', 'booking_flights', 'bookings', 'flights', 'routes', 'airports', 'sessions', 'users'];

export async function applySchema({ reset = false } = {}) {
  if (reset) await one(`DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE`);
  for (const stmt of SCHEMA.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !/^(--[^\n]*\n?)+$/.test(s))) {
    await one(stmt.includes('$$') ? `${stmt};` : stmt);
  }
}

/** Builds every demo row in memory. `light` seeds a small window (used by the tests). */
async function build({ light }) {
  const rand = mulberry32(20261107);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const HOUR = 3600000;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const T = {
    users: [], routes: [], flights: [], bookings: [], booking_flights: [], passengers: [], tickets: [], payments: [],
    refunds: [], cargo: [], cargo_events: [], support_tickets: [], ticket_messages: [], notifications: [], audit_log: [],
  };
  const ids = Object.fromEntries(Object.keys(T).map((k) => [k, 0]));
  const nextId = (t) => ++ids[t];

  // Users (ids 1–6; Abena is id 3, used as the staff author of a seeded support reply)
  const allPerms = JSON.stringify(Object.keys(STAFF_PERMISSIONS));
  const users = {};
  const mk = async (key, u, role, perms, extra = {}) => {
    const row = {
      id: nextId('users'), name: u.name, email: u.email, phone: extra.phone || '0244000000', national_id_enc: encrypt(extra.ghanaCard || null),
      password_hash: await hashPassword(u.password), role, permissions: perms, frequent_flyer_no: extra.ff || null,
      passport_enc: encrypt(extra.passport || null), passport_expiry: extra.passportExpiry || null, nationality: extra.nationality || null,
      dob: extra.dob || null, emergency_name: extra.emName || null, emergency_relation: extra.emRel || null, emergency_phone: extra.emPhone || null,
      created_at: iso(now - 200 * 24 * HOUR),
    };
    T.users.push(row);
    users[key] = row;
  };
  await mk('admin', DEMO_ACCOUNTS.admin, 'admin', allPerms, { phone: '0201112233' });
  await mk('admin2', DEMO_ACCOUNTS.admin2, 'admin', allPerms, { phone: '0501234567' });
  await mk('staff', DEMO_ACCOUNTS.staff, 'staff', JSON.stringify(['support', 'gate', 'bookings', 'cargo']), { phone: '0277654321' });
  await mk('ops', { name: 'Yaw Darko (Flight Ops)', email: 'yaw.darko@adinkra-air.test', password: 'Staff@2026' }, 'staff', JSON.stringify(['ops', 'gate']));
  await mk('kwame', DEMO_ACCOUNTS.traveler, 'traveler', '[]', {
    phone: '0244123456', ghanaCard: 'GHA-712345678-3', ff: 'ADK4471203', passport: 'G2847561', passportExpiry: '2031-03-14',
    nationality: 'Ghanaian', dob: '1992-04-18', emName: 'Akosua Mensah', emRel: 'Spouse', emPhone: '0209876543',
  });
  await mk('ama', { name: 'Ama Owusu', email: 'ama.owusu@example.com', password: 'Traveler@2026' }, 'traveler', '[]', { phone: '0551239876', ghanaCard: 'GHA-723456789-1' });

  // Routes + flights: 95 days back, 60 days ahead (light: 3 back, 20 ahead)
  for (const [fn, o, d, t, dur, price, ac, days] of ROUTES) {
    const route = {
      id: nextId('routes'), flight_no: fn, origin: o, destination: d, segment: segOf(o, d), base_price: price, duration_min: dur,
      aircraft: ac, dep_time: t, days, active: 1, created_at: iso(now - 400 * 24 * HOUR),
    };
    T.routes.push(route);
    for (const r of flightRows(route, light ? -3 : -95, light ? 20 : 60, rand)) {
      const f = Object.fromEntries(FLIGHT_COLS.map((col, i) => [col, r[i]]));
      Object.assign(f, { id: nextId('flights'), status: 'SCHEDULED', delay_min: 0, remarks: null, segment: route.segment, origin: o, destination: d });
      T.flights.push(f);
    }
  }
  T.flights.sort((a, b) => a.departure.localeCompare(b.departure));
  const takenByFlight = new Map(T.flights.map((f) => [f.id, new Set()]));

  // Historical & forward bookings
  const pnrs = new Set(['KWM4LN', 'KWM7KS', 'AMA3TK']);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const newPnr = () => {
    for (;;) {
      let p = '';
      for (let i = 0; i < 6; i++) p += chars[Math.floor(rand() * chars.length)];
      if (!pnrs.has(p)) { pnrs.add(p); return p; }
    }
  };
  let ticketSeq = 4100000000;
  const ticketNo = () => `${AIRLINE.ticketPrefix}${String(ticketSeq++).padStart(10, '0')}`;
  const popularity = { ACC: 1, KMS: 1.05, LOS: 1.1, LHR: 1.08, TML: 0.95, TKD: 0.8, NYI: 0.6, LFW: 0.7, DSS: 0.75, JFK: 1, DXB: 0.9, JNB: 0.8 };
  const payMethod = () => {
    const r = rand();
    if (r < 0.42) return ['MOMO', 'MTN', `024 ••• ${String(1000 + Math.floor(rand() * 9000))}`];
    if (r < 0.55) return ['MOMO', 'TELECEL', `020 ••• ${String(1000 + Math.floor(rand() * 9000))}`];
    if (r < 0.62) return ['MOMO', 'AIRTELTIGO', `027 ••• ${String(1000 + Math.floor(rand() * 9000))}`];
    if (r < 0.88) return ['CARD', 'VISA', `VISA •••• ${String(1000 + Math.floor(rand() * 9000))}`];
    return ['CARD', 'MASTERCARD', `MASTERCARD •••• ${String(1000 + Math.floor(rand() * 9000))}`];
  };

  for (const f of T.flights) {
    const dep = Date.parse(f.departure);
    const daysAhead = (dep - now) / (24 * HOUR);
    const pop = popularity[f.origin === 'ACC' ? f.destination : f.origin] || 0.8;
    let occ = (f.segment === 'DOMESTIC' ? 0.62 : f.segment === 'REGIONAL' ? 0.58 : 0.7) * pop + (rand() - 0.5) * 0.3;
    const dow = new Date(dep).getUTCDay();
    if (dow === 5 || dow === 0) occ += 0.08;
    if (daysAhead > 0) occ *= Math.max(0.08, 1 - daysAhead / 40);
    occ = Math.max(0.03, Math.min(0.98, occ));
    const layout = seatLayout(f.aircraft);
    for (const tier of layout.tiers) {
      const rate = tier === 'ECONOMY' ? occ : tier === 'BUSINESS' ? occ * 0.75 : occ * 0.55;
      const seats = layout.rows.filter((r) => r.tier === tier).flatMap((r) => r.groups.flat());
      let n = Math.round(seats.length * rate);
      let i = 0;
      while (n > 0) {
        const size = Math.min(n, pick([1, 1, 1, 2, 2, 2, 3, 4]));
        n -= size;
        const group = seats.slice(i, i + size);
        i += size;
        const leadDays = 1 + Math.floor(rand() * 40);
        // Past flights: booked 1–40 days before departure. Future flights: booked some time in the last 30 days.
        const created = daysAhead > 0 ? now - (1 + rand() * 29 * 24) * HOUR : Math.min(dep - leadDays * 24 * HOUR, now - HOUR);
        const createdIso = iso(created);
        const fare = fareFor(f.base_price, tier, rand() * occ);
        const tax = taxesFor(f.segment, fare);
        const total = (fare + tax) * size;
        const cancelled = rand() < 0.035;
        const last = pick(LAST);
        const contact = `${pick(FIRST).toLowerCase()}.${last.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}${Math.floor(rand() * 90 + 10)}@example.com`;
        const bid = nextId('bookings');
        T.bookings.push({
          id: bid, pnr: newPnr(), user_id: null, contact_email: contact,
          contact_phone: `0${pick(['24', '20', '54', '55', '27', '50'])}${String(Math.floor(rand() * 1e7)).padStart(7, '0')}`,
          trip_type: 'ONE_WAY', tier, segment: f.segment, status: cancelled ? 'CANCELLED' : 'CONFIRMED', total, taxes: tax * size,
          created_at: createdIso, updated_at: createdIso,
        });
        const bfid = nextId('booking_flights');
        T.booking_flights.push({ id: bfid, booking_id: bid, flight_id: f.id, direction: 'OUT', fare });
        const [method, provider, masked] = payMethod();
        T.payments.push({ id: nextId('payments'), booking_id: bid, kind: 'BOOKING', method, provider, account_masked: masked, amount: total, status: 'SUCCESS', txn_ref: `PSK_seed${bid}`, created_at: createdIso });
        if (cancelled) {
          const refundAt = iso(Math.min(now - HOUR, created + rand() * (dep - created)));
          T.refunds.push({ id: nextId('refunds'), booking_id: bid, amount: Math.round(total * 0.5), pct: 50, reason: 'Cancelled by customer online', created_at: refundAt });
        }
        for (let k = 0; k < size; k++) {
          const intl = f.segment !== 'DOMESTIC';
          const pid = nextId('passengers');
          T.passengers.push({
            id: pid, booking_id: bid, first_name: pick(FIRST), last_name: k === 0 ? last : rand() < 0.7 ? last : pick(LAST),
            dob: `${1950 + Math.floor(rand() * 55)}-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`, nationality: 'Ghanaian',
            passport_enc: intl ? encrypt(`G${String(Math.floor(rand() * 1e7)).padStart(7, '0')}`) : null, passport_expiry: intl ? '2030-06-30' : null, pax_type: 'ADULT',
          });
          const past = dep < now - HOUR;
          const status = cancelled ? 'CANCELLED' : past ? (rand() < 0.965 ? 'BOARDED' : 'CONFIRMED') : 'CONFIRMED';
          T.tickets.push({
            id: nextId('tickets'), ticket_no: ticketNo(), passenger_id: pid, booking_flight_id: bfid, seat: group[k], status,
            boarded_at: status === 'BOARDED' ? iso(dep - (10 + rand() * 30) * 60000) : null,
          });
          if (!cancelled) takenByFlight.get(f.id).add(group[k]);
        }
      }
    }
  }

  // ---- Scenario data ----
  const nextFlight = (o, d, minHours) => {
    const after = iso(now + minHours * HOUR);
    return T.flights.find((f) => f.origin === o && f.destination === d && f.departure > after);
  };
  const freeSeat = (f, tier, prefer) => {
    const tk = takenByFlight.get(f.id);
    const seats = seatLayout(f.aircraft).rows.filter((r) => r.tier === tier).flatMap((r) => r.groups.flat());
    return seats.find((s) => s === prefer && !tk.has(s)) || seats.find((s) => !tk.has(s));
  };
  const book = (pnr, user, f, tier, pax, method) => {
    const fare = fareFor(f.base_price, tier, 0.4);
    const tax = taxesFor(f.segment, fare);
    const total = (fare + tax) * pax.length;
    const created = iso(now - 6 * 24 * HOUR);
    const bid = nextId('bookings');
    T.bookings.push({ id: bid, pnr, user_id: user.id, contact_email: user.email, contact_phone: user.phone, trip_type: 'ONE_WAY', tier, segment: f.segment, status: 'CONFIRMED', total, taxes: tax * pax.length, created_at: created, updated_at: created });
    const bfid = nextId('booking_flights');
    T.booking_flights.push({ id: bfid, booking_id: bid, flight_id: f.id, direction: 'OUT', fare });
    T.payments.push({ id: nextId('payments'), booking_id: bid, kind: 'BOOKING', method: method[0], provider: method[1], account_masked: method[2], amount: total, status: 'SUCCESS', txn_ref: `PSK_demo_${pnr.toLowerCase()}`, created_at: created });
    for (const p of pax) {
      const pid = nextId('passengers');
      T.passengers.push({ id: pid, booking_id: bid, first_name: p.first, last_name: p.last, dob: p.dob, nationality: 'Ghanaian', passport_enc: encrypt(p.passport || null), passport_expiry: p.passport ? '2031-03-14' : null, pax_type: 'ADULT' });
      const seat = freeSeat(f, tier, p.seat);
      takenByFlight.get(f.id).add(seat);
      T.tickets.push({ id: nextId('tickets'), ticket_no: ticketNo(), passenger_id: pid, booking_flight_id: bfid, seat, status: 'CONFIRMED', boarded_at: null });
    }
    T.notifications.push({ id: nextId('notifications'), user_id: user.id, channel: 'EMAIL', recipient: user.email, subject: `Your e-ticket – booking ${pnr}`, body: `Booking ${pnr} is confirmed: ${f.flight_no} departing ${f.departure.slice(0, 16).replace('T', ' ')} GMT.`, created_at: created });
  };
  const { kwame, ama } = users;
  const kw = { first: 'Kwame', last: 'Mensah', dob: '1992-04-18', passport: 'G2847561' };
  // Scenario 1.2: upcoming domestic trip to Kumasi that Kwame will change.
  book('KWM7KS', kwame, nextFlight('ACC', 'KMS', 5 * 24), 'ECONOMY', [{ ...kw, seat: '5A' }], ['MOMO', 'MTN', '024 ••• 3456']);
  // Scenario 2.2: a flight departing soon for gate scanning (whatever departs Accra next, 1.5–30 h out).
  const soonFrom = iso(now + 1.5 * HOUR);
  const soonTo = iso(now + 30 * HOUR);
  const soon = T.flights.find((f) => f.origin === 'ACC' && f.departure > soonFrom && f.departure < soonTo);
  if (soon) book('KWM4LN', kwame, soon, 'ECONOMY', [kw], ['CARD', 'VISA', 'VISA •••• 4242']);
  // Scenario 2.3: Ama can't travel – staff will cancel.
  book('AMA3TK', ama, nextFlight('ACC', 'TKD', 10 * 24), 'ECONOMY', [{ first: 'Ama', last: 'Owusu', dob: '1995-09-02' }], ['MOMO', 'TELECEL', '020 ••• 9876']);

  // Scenario 2.5 + 1.3: next Lagos → Accra flight delayed; one regional flight cancelled.
  const los = nextFlight('LOS', 'ACC', 2);
  if (los) Object.assign(los, { delay_min: 95, remarks: 'Late inbound aircraft' });
  const lfw = nextFlight('ACC', 'LFW', 20);
  if (lfw) Object.assign(lfw, { status: 'CANCELLED', remarks: 'Technical – aircraft change' });
  const kms = nextFlight('ACC', 'KMS', 1);
  if (kms) Object.assign(kms, { delay_min: 20, remarks: 'Air traffic control' });

  // Scenario 2.1: support tickets
  const mkTicket = (ref, user, cat, subject, pnr, msgs, status = 'OPEN', ageH = 5) => {
    const at = iso(now - ageH * HOUR);
    const id = nextId('support_tickets');
    T.support_tickets.push({ id, ref, user_id: user.id, category: cat, subject, pnr, status, created_at: at, updated_at: at });
    msgs.forEach(([role, body], i) => T.ticket_messages.push({
      id: nextId('ticket_messages'), ticket_id: id, author_id: role === 'customer' ? user.id : users.staff.id, author_role: role, body, created_at: iso(now - (ageH - i) * HOUR),
    }));
  };
  mkTicket('SR-104233', kwame, 'BAGGAGE', 'Baggage allowance for my Kumasi flight', 'KWM7KS', [
    ['customer', 'Hello, I am travelling to Kumasi next week in Economy. How many kilograms of checked luggage can I bring, and can I carry a laptop bag on board as well?'],
  ]);
  mkTicket('SR-104251', ama, 'REFUND', 'Refund to Telecel Cash', 'AMA3TK', [
    ['customer', 'If I cancel my Takoradi flight, will the refund go back to my Telecel Cash wallet?'],
  ], 'OPEN', 2);
  mkTicket('SR-103980', kwame, 'BOOKING', 'Name spelling on ticket', null, [
    ['customer', 'My middle name is missing from a previous booking. Is that a problem?'],
    ['staff', 'Thank you for reaching out. Middle names are optional as long as first and last names match your ID. Safe travels!'],
  ], 'RESOLVED', 240);

  // Scenario 1.5 / 2.4: cargo requests
  const mkCargo = (awb, user, o, d, desc, type, pieces, kg, l, w, hgt, status, ageH) => {
    const price = cargoQuote({ segment: segOf(o, d), weightKg: kg, lengthCm: l, widthCm: w, heightCm: hgt, pieces, cargoType: type }).total;
    const at = iso(now - ageH * HOUR);
    const vol = (l * w * hgt * pieces) / 6000;
    const id = nextId('cargo');
    T.cargo.push({
      id, awb, user_id: user?.id ?? null, shipper_name: user?.name ?? 'Makola Traders Ltd', shipper_phone: user?.phone ?? '0302123456', shipper_email: user?.email ?? null,
      consignee_name: 'Alhassan Iddrisu', consignee_phone: '0244556677', origin: o, destination: d, description: desc, cargo_type: type,
      pieces, weight_kg: kg, length_cm: l, width_cm: w, height_cm: hgt, chargeable_kg: +Math.max(kg, vol).toFixed(1), price, status, created_at: at, updated_at: at,
    });
    T.cargo_events.push({ id: nextId('cargo_events'), cargo_id: id, status: 'PENDING', note: 'Booking request received online', created_at: at });
  };
  mkCargo('839-20481157', kwame, 'ACC', 'TML', 'Boxed mobile phone accessories for retail', 'GENERAL', 4, 86, 60, 40, 40, 'PENDING', 3);
  mkCargo('839-20481190', null, 'ACC', 'LOS', 'Kente cloth bales', 'GENERAL', 2, 140, 100, 60, 50, 'PENDING', 1);
  mkCargo('839-20480012', null, 'KMS', 'ACC', 'Fresh pineapples', 'PERISHABLE', 10, 300, 50, 40, 30, 'PENDING', 6);

  // A little audit history for the security dashboard
  const ips = ['41.66.200.14', '154.160.3.77', '102.176.65.9'];
  for (let i = 0; i < 6; i++) {
    T.audit_log.push({ id: nextId('audit_log'), user_id: null, action: 'auth.login_failed', target: pick(['admin@adinkra-air.test', DEMO_ACCOUNTS.staff.email]), details: 'attempt 1', severity: 'warn', ip: pick(ips), created_at: iso(now - rand() * 20 * HOUR) });
  }
  T.audit_log.push({ id: nextId('audit_log'), user_id: users.admin.id, action: 'security.key_check', target: 'DATA_KEY', details: 'Encryption self-test passed', severity: 'info', ip: '127.0.0.1', created_at: iso(now - 30 * HOUR) });
  void AIRCRAFT;
  return T;
}

const COLS = {
  users: ['id', 'name', 'email', 'phone', 'national_id_enc', 'password_hash', 'role', 'permissions', 'frequent_flyer_no', 'passport_enc', 'passport_expiry', 'nationality', 'dob', 'emergency_name', 'emergency_relation', 'emergency_phone', 'created_at'],
  routes: ['id', 'flight_no', 'origin', 'destination', 'segment', 'base_price', 'duration_min', 'aircraft', 'dep_time', 'days', 'active', 'created_at'],
  flights: ['id', ...FLIGHT_COLS, 'status', 'delay_min', 'remarks'],
  bookings: ['id', 'pnr', 'user_id', 'contact_email', 'contact_phone', 'trip_type', 'tier', 'segment', 'status', 'total', 'taxes', 'created_at', 'updated_at'],
  booking_flights: ['id', 'booking_id', 'flight_id', 'direction', 'fare'],
  passengers: ['id', 'booking_id', 'first_name', 'last_name', 'dob', 'nationality', 'passport_enc', 'passport_expiry', 'pax_type'],
  tickets: ['id', 'ticket_no', 'passenger_id', 'booking_flight_id', 'seat', 'status', 'boarded_at'],
  cargo: ['id', 'awb', 'user_id', 'shipper_name', 'shipper_phone', 'shipper_email', 'consignee_name', 'consignee_phone', 'origin', 'destination', 'description', 'cargo_type', 'pieces', 'weight_kg', 'length_cm', 'width_cm', 'height_cm', 'chargeable_kg', 'price', 'status', 'created_at', 'updated_at'],
  payments: ['id', 'booking_id', 'kind', 'method', 'provider', 'account_masked', 'amount', 'status', 'txn_ref', 'created_at'],
  refunds: ['id', 'booking_id', 'amount', 'pct', 'reason', 'created_at'],
  cargo_events: ['id', 'cargo_id', 'status', 'note', 'created_at'],
  support_tickets: ['id', 'ref', 'user_id', 'category', 'subject', 'pnr', 'status', 'created_at', 'updated_at'],
  ticket_messages: ['id', 'ticket_id', 'author_id', 'author_role', 'body', 'created_at'],
  notifications: ['id', 'user_id', 'channel', 'recipient', 'subject', 'body', 'created_at'],
  audit_log: ['id', 'user_id', 'action', 'target', 'details', 'severity', 'ip', 'created_at'],
};

/** Seeds an empty database. Returns false if it already has data. */
export async function seedIfEmpty({ light = false, log = () => {} } = {}) {
  await applySchema();
  if ((await one('SELECT COUNT(*) AS n FROM airports')).n > 0) return false;
  const t0 = Date.now();
  const T = await build({ light });
  log(`Built ${Object.values(T).reduce((s, r) => s + r.length, 0).toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s; inserting…`);
  await insertMany('airports', ['code', 'name', 'city', 'country', 'zone'], AIRPORTS);
  for (const [table, cols] of Object.entries(COLS)) {
    const rows = T[table];
    if (!rows.length) continue;
    const t = Date.now();
    await insertMany(table, cols, rows.map((r) => cols.map((c) => r[c])));
    log(`  ${table.padEnd(16)} ${String(rows.length).padStart(7)} rows  ${((Date.now() - t) / 1000).toFixed(1)}s`);
    // Rows were inserted with explicit ids, so move the identity sequence past them.
    await one(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${table}))`);
  }
  await one('ANALYZE');
  log(`Seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL to your Neon *direct* connection string (or the local PGlite URL).');
    process.exit(1);
  }
  const sql = connect(url, { max: 1, prepare: false });
  setDefaultDb(sql);
  try {
    const reset = process.argv.includes('--reset');
    if (reset) {
      console.log('Dropping existing tables…');
      await applySchema({ reset: true });
    }
    const seeded = await seedIfEmpty({ light: process.env.SEED_LIGHT === '1', log: console.log });
    if (!seeded) console.log('Database already has data – nothing to do. Use "npm run db:reset" to start over.');
    else {
      const counts = await all(`SELECT 'bookings' AS t, COUNT(*) AS n FROM bookings UNION ALL SELECT 'tickets', COUNT(*) FROM tickets UNION ALL SELECT 'flights', COUNT(*) FROM flights`);
      console.log(counts.map((r) => `${r.t}: ${r.n.toLocaleString()}`).join(', '));
    }
  } finally {
    await sql.end();
  }
}
