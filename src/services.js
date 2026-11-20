import { qrDataUrl } from './qr.js';
import crypto from 'node:crypto';
import { one, all, run, insert, tx, nowIso } from './db.js';
import { AIRPORTS, TIERS, seatLayout, fareFor, taxesFor, CHANGE_FEE, refundPolicy, BAGGAGE } from './domain.js';
import { liveStatus } from './status.js';
import { decrypt, mask, boardingCode, bad, HttpError } from './security.js';
import { AIRLINE } from './config.js';

export const AIRPORT = Object.fromEntries(
  AIRPORTS.map(([code, name, city, country, zone]) => [code, { code, name, city, country, zone }]),
);

const HOUR = 3600000;

// ---------- Identifiers ----------
const PNR_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomCode(len, chars = PNR_CHARS) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
export async function newPnr() {
  for (;;) {
    const pnr = randomCode(6);
    if (!(await one('SELECT 1 FROM bookings WHERE pnr = ?', pnr))) return pnr;
  }
}
export async function newTicketNo() {
  for (;;) {
    const n = AIRLINE.ticketPrefix + String(crypto.randomInt(0, 1e10)).padStart(10, '0');
    if (!(await one('SELECT 1 FROM tickets WHERE ticket_no = ?', n))) return n;
  }
}

// ---------- Holds ----------
/** Releases seats from unpaid bookings whose hold time has passed. */
export async function expireHolds() {
  const now = nowIso();
  const expired = await all("SELECT id FROM bookings WHERE status = 'HELD' AND hold_expires < ?", now);
  if (!expired.length) return 0;
  const ids = expired.map((r) => r.id);
  await tx(async () => {
    for (const id of ids) {
      await run("UPDATE bookings SET status = 'EXPIRED', updated_at = ? WHERE id = ? AND status = 'HELD'", now, id);
      await run(
        `UPDATE tickets SET status = 'CANCELLED' WHERE booking_flight_id IN (SELECT id FROM booking_flights WHERE booking_id = ?)`,
        id,
      );
    }
  });
  return ids.length;
}

// ---------- Flights & seats ----------
const FLIGHT_SQL = `SELECT f.*, r.origin, r.destination, r.segment, r.duration_min, r.active AS route_active
  FROM flights f JOIN routes r ON r.id = f.route_id`;

export const getFlight = (id) => one(`${FLIGHT_SQL} WHERE f.id = ?`, id);
export const queryFlights = (where, ...params) => all(`${FLIGHT_SQL} WHERE ${where}`, ...params);

/** Serialises seat assignment on a flight for the rest of the current transaction. */
export const lockFlight = (id) => one('SELECT id FROM flights WHERE id = ? FOR UPDATE', id);

export async function takenSeats(flightId) {
  const rows = await all(
    `SELECT t.seat FROM tickets t JOIN booking_flights bf ON bf.id = t.booking_flight_id
     WHERE bf.flight_id = ? AND t.status != 'CANCELLED'`,
    flightId,
  );
  return new Set(rows.map((r) => r.seat));
}

/** Seats taken on many flights in one query: Map(flightId → Set(seat)). */
export async function takenSeatsFor(flightIds) {
  const out = new Map(flightIds.map((id) => [id, new Set()]));
  if (!flightIds.length) return out;
  const rows = await all(
    `SELECT bf.flight_id, t.seat FROM tickets t JOIN booking_flights bf ON bf.id = t.booking_flight_id
     WHERE bf.flight_id = ANY(?::int[]) AND t.status != 'CANCELLED'`,
    `{${flightIds.map(Number).join(',')}}`,
  );
  for (const r of rows) out.get(r.flight_id).add(r.seat);
  return out;
}

/** Pure: per-tier capacity, availability and fares for a flight given its taken seats. */
export function availability(f, taken) {
  const layout = seatLayout(f.aircraft);
  const used = { ECONOMY: 0, BUSINESS: 0, FIRST: 0 };
  for (const s of taken) {
    const t = layout.tierOf.get(s);
    if (t) used[t]++;
  }
  return layout.tiers.map((tier) => {
    const cap = layout.capacity[tier];
    const fare = fareFor(f.base_price, tier, used[tier] / cap);
    return {
      tier,
      label: TIERS[tier].label,
      capacity: cap,
      available: cap - used[tier],
      fare,
      taxes: taxesFor(f.segment, fare),
    };
  });
}

/** Pure: API view of a flight. Pass `taken` to include per-tier availability. */
export function flightView(f, taken = null) {
  const o = AIRPORT[f.origin];
  const d = AIRPORT[f.destination];
  const view = {
    id: f.id,
    flightNo: f.flight_no,
    origin: f.origin,
    destination: f.destination,
    originCity: o?.city,
    destinationCity: d?.city,
    segment: f.segment,
    departure: f.departure,
    arrival: f.arrival,
    durationMin: Math.round((Date.parse(f.arrival) - Date.parse(f.departure)) / 60000),
    aircraft: f.aircraft,
    live: liveStatus(f),
  };
  if (taken) view.tiers = availability(f, taken);
  return view;
}

/** Flight views with availability for a list of flights (one seat query for all of them). */
export async function flightViewsWithAvailability(flights) {
  const taken = await takenSeatsFor(flights.map((f) => f.id));
  return flights.map((f) => flightView(f, taken.get(f.id)));
}

/** Picks `count` free seats in a tier, honouring preferences, keeping groups together where possible. */
export function pickSeats(aircraft, tier, count, taken, preferred = []) {
  const layout = seatLayout(aircraft);
  const chosen = [];
  const blocked = new Set(taken);
  for (const p of preferred) {
    if (chosen.length >= count) break;
    if (p && layout.tierOf.get(p) === tier && !blocked.has(p)) {
      chosen.push(p);
      blocked.add(p);
    }
  }
  for (const row of layout.rows) {
    if (row.tier !== tier) continue;
    for (const s of row.groups.flat()) {
      if (chosen.length >= count) return chosen;
      if (!blocked.has(s)) {
        chosen.push(s);
        blocked.add(s);
      }
    }
  }
  if (chosen.length < count) throw bad(`Not enough ${TIERS[tier].label} seats left on this flight`);
  return chosen;
}

// ---------- Notifications (simulated email/SMS outbox) ----------
export async function notify({ userId = null, email, phone, subject, body }) {
  if (email) await run('INSERT INTO notifications (user_id, channel, recipient, subject, body) VALUES (?,?,?,?,?)', userId, 'EMAIL', email, subject, body);
  if (phone) await run('INSERT INTO notifications (user_id, channel, recipient, subject, body) VALUES (?,?,?,?,?)', userId, 'SMS', phone, subject, body.slice(0, 300));
}

// ---------- Booking detail ----------
export function bookingSegments(bookingId) {
  return all(
    `SELECT bf.id AS bf_id, bf.direction, bf.fare, f.*, r.origin, r.destination, r.segment
     FROM booking_flights bf JOIN flights f ON f.id = bf.flight_id JOIN routes r ON r.id = f.route_id
     WHERE bf.booking_id = ? ORDER BY CASE bf.direction WHEN 'OUT' THEN 0 ELSE 1 END`,
    bookingId,
  );
}

export async function bookingDetail(b, { revealPII = false, withQr = true } = {}) {
  const [segs, pax, tickets, payments, refunds] = await Promise.all([
    bookingSegments(b.id),
    all('SELECT * FROM passengers WHERE booking_id = ? ORDER BY id', b.id),
    all(`SELECT t.* FROM tickets t JOIN passengers p ON p.id = t.passenger_id WHERE p.booking_id = ? ORDER BY t.id`, b.id),
    all('SELECT kind, method, provider, account_masked, amount, status, txn_ref, created_at FROM payments WHERE booking_id = ? ORDER BY id', b.id),
    all('SELECT amount, pct, reason, created_at FROM refunds WHERE booking_id = ?', b.id),
  ]);
  const confirmed = b.status === 'CONFIRMED';
  const passengers = [];
  for (const p of pax) {
    const pp = p.passport_enc ? decrypt(p.passport_enc) : null;
    const pt = [];
    for (const t of tickets.filter((x) => x.passenger_id === p.id)) {
      const code = boardingCode(t.ticket_no);
      pt.push({
        ticketNo: t.ticket_no,
        segmentId: t.booking_flight_id,
        seat: t.seat,
        status: t.status,
        boardedAt: t.boarded_at,
        qr: withQr && confirmed && t.status !== 'CANCELLED' ? await qrDataUrl(code, { margin: 1, width: 220 }) : null,
        code: confirmed && t.status !== 'CANCELLED' ? code : null,
      });
    }
    passengers.push({
      id: p.id,
      firstName: p.first_name,
      lastName: p.last_name,
      dob: p.dob,
      nationality: p.nationality,
      type: p.pax_type,
      passport: pp ? (revealPII ? pp : mask(pp)) : null,
      passportExpiry: p.passport_expiry,
      tickets: pt,
    });
  }
  const paid = payments.filter((p) => p.status === 'SUCCESS').reduce((s, p) => s + p.amount, 0);
  return {
    pnr: b.pnr,
    status: b.status,
    tier: b.tier,
    tierLabel: TIERS[b.tier].label,
    tripType: b.trip_type,
    segment: b.segment,
    total: b.total,
    taxes: b.taxes,
    paid,
    refunded: refunds.reduce((s, r) => s + r.amount, 0),
    holdExpires: b.hold_expires,
    createdAt: b.created_at,
    contactEmail: b.contact_email,
    contactPhone: b.contact_phone,
    baggage: BAGGAGE[b.segment][b.tier],
    segments: segs.map((s) => ({ ...flightView(s), segmentId: s.bf_id, direction: s.direction, fare: s.fare })),
    passengers,
    payments,
    refunds,
  };
}

// ---------- Date changes / re-routing ----------
function activeTickets(bfId) {
  return all("SELECT * FROM tickets WHERE booking_flight_id = ? AND status != 'CANCELLED' ORDER BY id", bfId);
}

export async function changeOptions(b, bfId, { staff = false } = {}) {
  if (b.status !== 'CONFIRMED') throw bad('Only confirmed bookings can be changed');
  const segs = await bookingSegments(b.id);
  const seg = segs.find((s) => s.bf_id === Number(bfId));
  if (!seg) throw new HttpError(404, 'Flight segment not found on this booking');
  const tickets = await activeTickets(seg.bf_id);
  if (tickets.some((t) => t.status === 'BOARDED')) throw bad('This flight has already been boarded');
  const minLead = staff ? 0.5 * HOUR : 3 * HOUR;
  if (!staff && Date.parse(seg.departure) < Date.now() + minLead) {
    throw bad('Online changes close 3 hours before departure. Please contact customer support.');
  }
  const other = segs.find((s) => s.bf_id !== seg.bf_id);
  const earliest = new Date(Math.max(Date.now() + minLead, other && seg.direction === 'RET' ? Date.parse(other.arrival) + HOUR : 0)).toISOString();
  const latestMs = other && seg.direction === 'OUT' ? Date.parse(other.departure) - HOUR : Date.now() + 90 * 24 * HOUR;
  const candidates = (await queryFlights(
    `r.origin = ? AND r.destination = ? AND f.departure > ? AND f.id != ? AND f.status != 'CANCELLED' AND r.active = 1 ORDER BY f.departure LIMIT 60`,
    seg.origin,
    seg.destination,
    earliest,
    seg.id,
  )).filter((f) => Date.parse(f.arrival) <= latestMs);
  const taken = await takenSeatsFor(candidates.map((f) => f.id));
  const n = tickets.length;
  const fee = staff ? 0 : CHANGE_FEE[seg.segment];
  const options = [];
  for (const f of candidates) {
    const tier = availability(f, taken.get(f.id)).find((t) => t.tier === b.tier);
    if (!tier || tier.available < n) continue;
    const diff = staff ? 0 : Math.max(0, tier.fare - seg.fare);
    options.push({
      ...flightView(f),
      fare: tier.fare,
      seatsLeft: tier.available,
      feePerPax: fee,
      fareDiffPerPax: diff,
      totalCharge: n * (fee + diff),
    });
    if (options.length >= (staff ? 8 : 30)) break;
  }
  return { current: { ...flightView(seg), segmentId: seg.bf_id, fare: seg.fare }, passengers: n, options };
}

export async function applyChange(b, bfId, newFlightId, { staff = false, actor = null, reason = null } = {}) {
  const { current, options } = await changeOptions(b, bfId, { staff });
  const opt = options.find((o) => o.id === Number(newFlightId));
  if (!opt) throw bad('That flight is no longer available for this change');
  const newFlight = await getFlight(opt.id);
  const result = await tx(async () => {
    await lockFlight(newFlight.id);
    const tickets = await activeTickets(bfId);
    const seats = pickSeats(newFlight.aircraft, b.tier, tickets.length, await takenSeats(newFlight.id), tickets.map((t) => t.seat));
    for (const [i, t] of tickets.entries()) await run('UPDATE tickets SET seat = ? WHERE id = ?', seats[i], t.id);
    await run('UPDATE booking_flights SET flight_id = ?, fare = ? WHERE id = ?', newFlight.id, Math.max(current.fare, opt.fare), bfId);
    if (opt.totalCharge > 0) {
      const last = await one("SELECT method, provider, account_masked FROM payments WHERE booking_id = ? AND status = 'SUCCESS' ORDER BY id DESC", b.id);
      await run(
        `INSERT INTO payments (booking_id, kind, method, provider, account_masked, amount, status, txn_ref, message)
         VALUES (?, 'CHANGE', ?, ?, ?, ?, 'SUCCESS', ?, 'Date change fee + fare difference')`,
        b.id, last?.method || 'CARD', last?.provider, last?.account_masked, opt.totalCharge, `CHG_${randomCode(12)}`,
      );
      await run('UPDATE bookings SET total = total + ? WHERE id = ?', opt.totalCharge, b.id);
    }
    await run('UPDATE bookings SET updated_at = ? WHERE id = ?', nowIso(), b.id);
    const when = new Date(newFlight.departure).toUTCString().replace(':00 GMT', ' GMT');
    await notify({
      userId: b.user_id,
      email: b.contact_email,
      phone: b.contact_phone,
      subject: `${staff ? 'You have been re-booked' : 'Booking updated'} – ${b.pnr}`,
      body:
        `${staff ? `Due to ${reason || 'a schedule change'}, we have moved you` : 'Your booking has been changed'} to flight ${newFlight.flight_no} ` +
        `${newFlight.origin}→${newFlight.destination} departing ${when}. New seats: ${seats.join(', ')}. ` +
        `Your updated e-ticket is available under Manage Booking with reference ${b.pnr}.`,
    });
    return { seats };
  });
  return { flight: opt, seats: result.seats, charged: opt.totalCharge, actor };
}

// ---------- Cancellation ----------
export async function cancelQuote(b) {
  if (b.status !== 'CONFIRMED') throw bad(`This booking is ${b.status.toLowerCase()} and cannot be cancelled`);
  const segs = await bookingSegments(b.id);
  const boarded = (await one(
    `SELECT COUNT(*) AS n FROM tickets t JOIN booking_flights bf ON bf.id = t.booking_flight_id WHERE bf.booking_id = ? AND t.status = 'BOARDED'`,
    b.id,
  )).n;
  if (boarded) throw bad('Part of this booking has already been flown and cannot be cancelled online');
  const firstDep = Math.min(...segs.map((s) => Date.parse(s.departure)));
  if (firstDep < Date.now()) throw bad('This flight has already departed');
  const hours = (firstDep - Date.now()) / HOUR;
  const policy = refundPolicy(hours);
  const paid = (await one("SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE booking_id = ? AND status = 'SUCCESS' AND kind != 'CARGO'", b.id)).s;
  return { paid, hoursToDeparture: Math.round(hours), ...policy, refund: Math.round((paid * policy.pct) / 100) };
}

export async function cancelBooking(b, { actor = null, reason = 'Customer request', waive = false } = {}) {
  const quote = await cancelQuote(b);
  const pct = waive ? 100 : quote.pct;
  const refund = Math.round((quote.paid * pct) / 100);
  await tx(async () => {
    const r = await run("UPDATE bookings SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status = 'CONFIRMED'", nowIso(), b.id);
    if (!r.changes) throw new HttpError(409, 'This booking was changed by someone else. Reload and try again.');
    await run(
      `UPDATE tickets SET status = 'CANCELLED' WHERE booking_flight_id IN (SELECT id FROM booking_flights WHERE booking_id = ?)`,
      b.id,
    );
    await insert('INSERT INTO refunds (booking_id, amount, pct, reason, processed_by) VALUES (?,?,?,?,?)', b.id, refund, pct, reason, actor);
  });
  await notify({
    userId: b.user_id,
    email: b.contact_email,
    phone: b.contact_phone,
    subject: `Booking ${b.pnr} cancelled`,
    body: `Your booking ${b.pnr} has been cancelled. A refund of GHS ${refund.toFixed(2)} (${pct}%) has been sent to your original payment method and should arrive within 5–7 working days.`,
  });
  return { ...quote, pct, refund };
}
