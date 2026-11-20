import { Hono } from 'hono';
import { h } from '../http.js';
import { one, all, run, insert, tx, nowIso, settingNum } from '../db.js';
import {
  HttpError, bad, requireAuth, hasPerm, encrypt, bookingToken, verifyBookingToken, audit, makeLimiter,
} from '../security.js';
import { seatLayout, TIERS, taxesFor } from '../domain.js';
import {
  getFlight, availability, takenSeats, pickSeats, newPnr, newTicketNo, bookingDetail, expireHolds, notify,
  changeOptions, applyChange, cancelQuote, cancelBooking, bookingSegments, lockFlight,
} from '../services.js';
import { charge } from '../gateway.js';
import { renderETicket } from '../eticket.js';
import { EMAIL_RE, PHONE_RE, cleanPhone } from './auth.js';
import { toId } from '../http.js';

const router = new Hono();
const lookupLimiter = makeLimiter('lookup', { max: 15, windowMs: 10 * 60000 });
const NAME_RE = /^[\p{L}][\p{L}' .-]{0,49}$/u;
const PASSPORT_RE = /^[A-Z0-9]{6,12}$/;

/** Resolves a booking the caller may access: owner, staff with "bookings", or a valid PNR+surname token. */
export async function loadBooking(req) {
  const pnr = String(req.params.pnr || '').toUpperCase();
  const b = await one('SELECT * FROM bookings WHERE pnr = ?', pnr);
  const ok =
    b &&
    ((req.user && (b.user_id === req.user.id || hasPerm(req.user, 'bookings'))) ||
      verifyBookingToken(req.get('X-Booking-Token'), pnr));
  if (!ok) throw new HttpError(404, 'Booking not found');
  return b;
}

router.post('/', requireAuth, h(async (req, c) => {
  await expireHolds();
  const { outboundFlightId, returnFlightId, tier, passengers, contactEmail, contactPhone } = req.body || {};
  if (!TIERS[tier]) throw bad('Choose a cabin class');
  if (!Array.isArray(passengers) || passengers.length < 1 || passengers.length > 9) throw bad('Between 1 and 9 passengers per booking');
  const email = String(contactEmail || req.user.email).trim().toLowerCase();
  const phone = cleanPhone(contactPhone);
  if (!EMAIL_RE.test(email)) throw bad('Enter a valid contact email');
  if (!PHONE_RE.test(phone)) throw bad('Enter a valid contact phone number');

  const out = await getFlight(toId(outboundFlightId));
  if (!out) throw bad('Outbound flight not found');
  const ret = returnFlightId ? await getFlight(toId(returnFlightId)) : null;
  if (returnFlightId && !ret) throw bad('Return flight not found');
  const flights = [out, ret].filter(Boolean);
  for (const f of flights) {
    if (f.status === 'CANCELLED' || !f.route_active) throw bad(`Flight ${f.flight_no} is not available for booking`);
    if (Date.parse(f.departure) < Date.now() + 60 * 60000) throw bad(`Flight ${f.flight_no} has closed for booking`);
    if (!seatLayout(f.aircraft).tiers.includes(tier)) throw bad(`${TIERS[tier].label} is not offered on ${f.flight_no}`);
  }
  if (ret) {
    if (ret.origin !== out.destination || ret.destination !== out.origin) throw bad('Return flight must be the reverse route');
    if (Date.parse(ret.departure) < Date.parse(out.arrival) + 60 * 60000) throw bad('Return flight must leave at least 1 hour after you arrive');
  }
  const intl = out.segment !== 'DOMESTIC';
  const firstDep = out.departure.slice(0, 10);
  const pax = passengers.map((p, i) => {
    const label = `Passenger ${i + 1}`;
    const first = String(p?.firstName || '').trim();
    const last = String(p?.lastName || '').trim();
    if (!NAME_RE.test(first) || !NAME_RE.test(last)) throw bad(`${label}: enter first and last name as on the ID`);
    const dob = String(p.dob || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || dob > nowIso().slice(0, 10)) throw bad(`${label}: enter a valid date of birth`);
    const age = (Date.parse(firstDep) - Date.parse(dob)) / (365.25 * 86400000);
    const passport = String(p.passportNo || '').trim().toUpperCase().replace(/\s/g, '');
    if (intl || passport) {
      if (!PASSPORT_RE.test(passport)) throw bad(`${label}: passport number must be 6–12 letters/digits`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.passportExpiry || '')) || p.passportExpiry <= (ret || out).departure.slice(0, 10)) {
        throw bad(`${label}: passport must be valid beyond your travel dates`);
      }
    }
    return {
      first, last, dob, passport: passport || null,
      passportExpiry: passport ? p.passportExpiry : null,
      nationality: String(p.nationality || 'Ghanaian').slice(0, 40),
      type: age < 2 ? 'INFANT' : age < 12 ? 'CHILD' : 'ADULT',
      seats: p.seats || {},
    };
  });
  if (!pax.some((p) => p.type === 'ADULT')) throw bad('At least one adult (12+) must travel on the booking');
  const holdMinutes = await settingNum('booking_hold_minutes');

  const result = await tx(async () => {
    const seatPlan = [];
    for (const [idx, f] of flights.entries()) {
      await lockFlight(f.id);
      const dir = idx === 0 ? 'out' : 'ret';
      const taken = await takenSeats(f.id);
      const tierInfo = availability(f, taken).find((t) => t.tier === tier);
      if (tierInfo.available < pax.length) throw bad(`Only ${tierInfo.available} ${TIERS[tier].label} seat(s) left on ${f.flight_no}`);
      const layout = seatLayout(f.aircraft);
      const wanted = pax.map((p) => (p.seats[dir] ? String(p.seats[dir]).toUpperCase() : null));
      for (const s of wanted.filter(Boolean)) {
        if (layout.tierOf.get(s) !== tier) throw bad(`Seat ${s} is not in ${TIERS[tier].label} on ${f.flight_no}`);
        if (taken.has(s)) throw new HttpError(409, `Seat ${s} on ${f.flight_no} was just taken – please pick another`);
      }
      if (new Set(wanted.filter(Boolean)).size !== wanted.filter(Boolean).length) throw bad('Each passenger needs a different seat');
      const auto = pickSeats(f.aircraft, tier, wanted.filter((w) => !w).length, new Set([...taken, ...wanted.filter(Boolean)]));
      const seats = wanted.map((w) => w || auto.shift());
      seatPlan.push({ f, fare: tierInfo.fare, seats });
    }
    const farePax = seatPlan.reduce((s, sp) => s + sp.fare, 0);
    const taxPax = seatPlan.reduce((s, sp) => s + taxesFor(sp.f.segment, sp.fare), 0);
    const total = (farePax + taxPax) * pax.length;
    const pnr = await newPnr();
    const holdUntil = new Date(Date.now() + holdMinutes * 60000).toISOString();
    const bookingId = await insert(
      `INSERT INTO bookings (pnr, user_id, contact_email, contact_phone, trip_type, tier, segment, status, total, taxes, hold_expires)
       VALUES (?,?,?,?,?,?,?, 'HELD', ?, ?, ?)`,
      pnr, req.user.id, email, phone, ret ? 'ROUND_TRIP' : 'ONE_WAY', tier, out.segment, total, taxPax * pax.length, holdUntil,
    );
    const bfIds = [];
    for (const [idx, sp] of seatPlan.entries()) {
      bfIds.push(await insert('INSERT INTO booking_flights (booking_id, flight_id, direction, fare) VALUES (?,?,?,?)', bookingId, sp.f.id, idx === 0 ? 'OUT' : 'RET', sp.fare));
    }
    for (const [i, p] of pax.entries()) {
      const pid = await insert(
        `INSERT INTO passengers (booking_id, first_name, last_name, dob, nationality, passport_enc, passport_expiry, pax_type) VALUES (?,?,?,?,?,?,?,?)`,
        bookingId, p.first, p.last, p.dob, p.nationality, encrypt(p.passport), p.passportExpiry, p.type,
      );
      for (const [idx, sp] of seatPlan.entries()) {
        await run(`INSERT INTO tickets (ticket_no, passenger_id, booking_flight_id, seat, status) VALUES (?,?,?,?, 'HELD')`, await newTicketNo(), pid, bfIds[idx], sp.seats[i]);
      }
    }
    return { pnr, total, holdUntil };
  });
  await audit(req, 'booking.hold', { target: result.pnr, details: { total: result.total } });
  return c.json({ pnr: result.pnr, total: result.total, holdExpires: result.holdUntil, token: bookingToken(result.pnr) }, 201);
}));

router.get('/mine', requireAuth, h(async (req, c) => {
  await expireHolds();
  const rows = await all(
    `SELECT b.pnr, b.status, b.tier, b.trip_type, b.total, b.created_at,
       (SELECT MIN(f.departure) FROM booking_flights bf JOIN flights f ON f.id = bf.flight_id WHERE bf.booking_id = b.id) AS first_departure,
       (SELECT string_agg(r.origin || '-' || r.destination || '|' || f.flight_no || '|' || f.departure, ';')
          FROM booking_flights bf JOIN flights f ON f.id = bf.flight_id JOIN routes r ON r.id = f.route_id WHERE bf.booking_id = b.id) AS legs,
       (SELECT COUNT(*) FROM passengers p WHERE p.booking_id = b.id) AS pax
     FROM bookings b WHERE b.user_id = ? AND b.status != 'EXPIRED' ORDER BY first_departure DESC NULLS LAST`,
    req.user.id,
  );
  return c.json({
    bookings: rows.map((r) => ({
      pnr: r.pnr, status: r.status, tier: r.tier, tripType: r.trip_type, total: r.total, pax: r.pax,
      firstDeparture: r.first_departure,
      legs: String(r.legs || '').split(';').filter(Boolean).map((l) => {
        const [route, flightNo, departure] = l.split('|');
        return { route, flightNo, departure };
      }).sort((a, b) => a.departure.localeCompare(b.departure)),
    })),
  });
}));

router.post('/lookup', h(async (req, c) => {
  const pnr = String(req.body?.pnr || '').trim().toUpperCase();
  const surname = String(req.body?.surname || '').trim().toLowerCase();
  if (await lookupLimiter.blocked(req.ip)) throw new HttpError(429, 'Too many lookups. Please wait a few minutes.');
  const b = await one('SELECT id, pnr FROM bookings WHERE pnr = ?', pnr);
  const match = b && (await one('SELECT 1 FROM passengers WHERE booking_id = ? AND lower(last_name) = ?', b.id, surname));
  if (!match) {
    await lookupLimiter.hit(req.ip);
    await audit(req, 'booking.lookup_failed', { target: pnr, severity: 'warn' });
    throw new HttpError(404, 'No booking matches that reference and surname');
  }
  return c.json({ pnr, token: bookingToken(pnr) });
}));

router.get('/:pnr', h(async (req, c) => {
  await expireHolds();
  const b = await loadBooking(req);
  return c.json({ booking: await bookingDetail(b) });
}));

router.post('/:pnr/pay', h(async (req, c) => {
  await expireHolds();
  const b = await loadBooking(req);
  if (b.status === 'CONFIRMED') throw new HttpError(409, 'This booking is already paid');
  if (b.status !== 'HELD') throw bad('This seat hold has expired. Please search and book again.');
  const result = charge({ ...req.body, amount: b.total });
  await run(
    `INSERT INTO payments (booking_id, kind, method, provider, account_masked, amount, status, txn_ref, message) VALUES (?, 'BOOKING', ?,?,?,?,?,?,?)`,
    b.id, result.method, result.provider, result.masked, b.total, result.ok ? 'SUCCESS' : 'FAILED', result.ref, result.message,
  );
  if (!result.ok) {
    await audit(req, 'payment.failed', { target: b.pnr, details: result.message, severity: 'warn' });
    throw new HttpError(402, result.message, { txnRef: result.ref });
  }
  await tx(async () => {
    const r = await run("UPDATE bookings SET status = 'CONFIRMED', hold_expires = NULL, updated_at = ? WHERE id = ? AND status = 'HELD'", nowIso(), b.id);
    if (!r.changes) throw new HttpError(409, 'This booking is already paid');
    await run(`UPDATE tickets SET status = 'CONFIRMED' WHERE booking_flight_id IN (SELECT id FROM booking_flights WHERE booking_id = ?)`, b.id);
  });
  const segs = await bookingSegments(b.id);
  const itin = segs.map((s) => `${s.flight_no} ${s.origin}→${s.destination} ${s.departure.slice(0, 16).replace('T', ' ')} GMT`).join('; ');
  await notify({
    userId: b.user_id,
    email: b.contact_email,
    phone: b.contact_phone,
    subject: `Your e-ticket – booking ${b.pnr}`,
    body: `Payment of GHS ${b.total.toFixed(2)} received (ref ${result.ref}). Booking ${b.pnr} is confirmed: ${itin}. Your PDF e-ticket with boarding QR code is attached and available under Manage Booking.`,
  });
  await audit(req, 'payment.success', { target: b.pnr, details: { amount: b.total, method: result.method, ref: result.ref } });
  const fresh = await one('SELECT * FROM bookings WHERE id = ?', b.id);
  return c.json({ txnRef: result.ref, message: result.message, booking: await bookingDetail(fresh) });
}));

router.get('/:pnr/eticket.pdf', h(async (req) => {
  const b = await loadBooking(req);
  if (b.status !== 'CONFIRMED') throw bad('E-tickets are available once the booking is paid');
  const pdf = await renderETicket(await bookingDetail(b, { withQr: false }));
  return new Response(pdf, {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="eticket-${b.pnr}.pdf"` },
  });
}));

router.get('/:pnr/change-options', h(async (req, c) => {
  const b = await loadBooking(req);
  return c.json(await changeOptions(b, req.query.segmentId));
}));

router.post('/:pnr/change', h(async (req, c) => {
  const b = await loadBooking(req);
  const r = await applyChange(b, req.body?.segmentId, req.body?.newFlightId, { actor: req.user?.id });
  await audit(req, 'booking.change', { target: b.pnr, details: { to: r.flight.flightNo, charged: r.charged } });
  return c.json({ ...r, booking: await bookingDetail(await one('SELECT * FROM bookings WHERE id = ?', b.id)) });
}));

router.get('/:pnr/cancel-quote', h(async (req, c) => c.json(await cancelQuote(await loadBooking(req)))));

router.post('/:pnr/cancel', h(async (req, c) => {
  const b = await loadBooking(req);
  const r = await cancelBooking(b, { actor: req.user?.id, reason: 'Cancelled by customer online' });
  await audit(req, 'booking.cancel', { target: b.pnr, details: { refund: r.refund, pct: r.pct } });
  return c.json({ ...r, booking: await bookingDetail(await one('SELECT * FROM bookings WHERE id = ?', b.id)) });
}));

export default router;
