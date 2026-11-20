import { Hono } from 'hono';
import { h, toId } from '../http.js';
import { one, all, run, tx, insertMany, nowIso, setting } from '../db.js';
import { bad, HttpError, requireRole, requirePerm, requireAnyPerm, parseBoardingCode, audit } from '../security.js';
import { BAGGAGE, CARGO_TYPES, AIRCRAFT, seatLayout, TIERS } from '../domain.js';
import {
  getFlight, queryFlights, flightView, bookingDetail, changeOptions, applyChange, cancelQuote, cancelBooking, notify,
} from '../services.js';
import { ticketView } from './support.js';
import { liveStatus } from '../status.js';

const router = new Hono();
router.use('*', requireRole('staff', 'admin'));

// ---------------- Support desk ----------------
const baggageText = (seg) =>
  Object.entries(BAGGAGE[seg]).map(([tier, b]) => `${TIERS[tier].label}: checked ${b.checked}, cabin ${b.cabin}`).join('; ');

const TEMPLATES = [
  { id: 'bag-dom', label: 'Baggage – domestic', body: `Thank you for contacting Adinkra Airways. On domestic flights the allowance per passenger is: ${baggageText('DOMESTIC')}. Excess baggage is GHS 15 per kg, payable at check-in.` },
  { id: 'bag-reg', label: 'Baggage – regional', body: `Thank you for contacting Adinkra Airways. On regional (West Africa) flights the allowance per passenger is: ${baggageText('REGIONAL')}. Extra bags can be prepaid via Manage Booking or support.` },
  { id: 'bag-int', label: 'Baggage – international', body: `Thank you for contacting Adinkra Airways. On international flights the allowance per passenger is: ${baggageText('INTERNATIONAL')}. Each bag must not exceed 158 cm (L+W+H).` },
  { id: 'refund', label: 'Refund timeline', body: 'Your refund has been processed to your original payment method. Mobile Money refunds arrive within 48 hours; card refunds within 5–7 working days.' },
  { id: 'close', label: 'Closing note', body: 'We are glad we could help. This request will now be marked as resolved — reply any time if you need anything else. Akwaaba!' },
];

router.get('/support', requirePerm('support'), h(async (req, c) => {
  const status = req.query.status;
  const [rows, countRows] = await Promise.all([
    all(
      `SELECT t.*, u.name AS customer, (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS messages,
         (SELECT m.author_role FROM ticket_messages m WHERE m.ticket_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_author
       FROM support_tickets t JOIN users u ON u.id = t.user_id ${status ? 'WHERE t.status = ?' : ''}
       ORDER BY CASE t.status WHEN 'OPEN' THEN 0 WHEN 'IN_PROGRESS' THEN 1 ELSE 2 END, t.updated_at DESC LIMIT 200`,
      ...(status ? [status] : []),
    ),
    all('SELECT status, COUNT(*) AS n FROM support_tickets GROUP BY status'),
  ]);
  return c.json({
    counts: Object.fromEntries(countRows.map((r) => [r.status, r.n])),
    templates: TEMPLATES,
    tickets: rows.map((t) => ({ ref: t.ref, subject: t.subject, category: t.category, status: t.status, customer: t.customer, pnr: t.pnr, messages: t.messages, awaitingReply: t.last_author === 'customer', updatedAt: t.updated_at })),
  });
}));

router.get('/support/:ref', requirePerm('support'), h(async (req, c) => {
  const t = await one('SELECT * FROM support_tickets WHERE ref = ?', req.params.ref);
  if (!t) throw new HttpError(404, 'Ticket not found');
  return c.json({ ticket: await ticketView(t, { staff: true }), templates: TEMPLATES });
}));

router.post('/support/:ref/reply', requirePerm('support'), h(async (req, c) => {
  const t = await one('SELECT * FROM support_tickets WHERE ref = ?', req.params.ref);
  if (!t) throw new HttpError(404, 'Ticket not found');
  const body = String(req.body?.message || '').trim();
  const status = req.body?.status || 'IN_PROGRESS';
  if (!['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].includes(status)) throw bad('Invalid status');
  if (!body && status === t.status) throw bad('Write a reply or change the status');
  await tx(async () => {
    if (body) await run('INSERT INTO ticket_messages (ticket_id, author_id, author_role, body) VALUES (?,?,?,?)', t.id, req.user.id, 'staff', body.slice(0, 4000));
    await run('UPDATE support_tickets SET status = ?, assigned_to = ?, updated_at = ? WHERE id = ?', status, req.user.id, nowIso(), t.id);
  });
  const owner = await one('SELECT id, email, phone FROM users WHERE id = ?', t.user_id);
  if (body) await notify({ userId: owner.id, email: owner.email, subject: `Update on your request ${t.ref}`, body: body.slice(0, 500) });
  await audit(req, 'support.reply', { target: t.ref, details: { status } });
  return c.json({ ticket: await ticketView(await one('SELECT * FROM support_tickets WHERE id = ?', t.id), { staff: true }) });
}));

// ---------------- Flights for gate / manifests / ops ----------------
// Flight list feeds the gate, manifest and ops screens only.
router.get('/flights', requireAnyPerm('gate', 'ops'), h(async (req, c) => {
  const hoursBack = Math.min(48, Number(req.query.back) || 6);
  const hoursFwd = Math.min(72, Number(req.query.ahead) || 30);
  const from = new Date(Date.now() - hoursBack * 3600000).toISOString();
  const to = new Date(Date.now() + hoursFwd * 3600000).toISOString();
  const [rows, countRows] = await Promise.all([
    queryFlights('f.departure >= ? AND f.departure < ? ORDER BY f.departure', from, to),
    all(
      `SELECT bf.flight_id AS id, COUNT(*) FILTER (WHERE t.status != 'CANCELLED') AS pax, COUNT(*) FILTER (WHERE t.status = 'BOARDED') AS boarded
       FROM tickets t JOIN booking_flights bf ON bf.id = t.booking_flight_id JOIN flights f ON f.id = bf.flight_id
       WHERE f.departure >= ? AND f.departure < ? GROUP BY bf.flight_id`,
      from, to,
    ),
  ]);
  const counts = Object.fromEntries(countRows.map((r) => [r.id, r]));
  return c.json({
    flights: rows.map((f) => ({
      ...flightView(f),
      delayMin: f.delay_min, gate: f.gate, remarks: f.remarks, status: f.status,
      capacity: seatLayout(f.aircraft).capacity.total,
      pax: counts[f.id]?.pax || 0, boarded: counts[f.id]?.boarded || 0,
    })),
  });
}));

async function manifest(flightId) {
  const rows = await all(
    `SELECT t.ticket_no, t.seat, t.status, t.boarded_at, p.first_name, p.last_name, p.pax_type, b.pnr, b.tier
     FROM tickets t JOIN passengers p ON p.id = t.passenger_id JOIN booking_flights bf ON bf.id = t.booking_flight_id
     JOIN bookings b ON b.id = bf.booking_id
     WHERE bf.flight_id = ? AND t.status IN ('CONFIRMED','BOARDED')
     ORDER BY (substring(t.seat from '^[0-9]+'))::int, t.seat`,
    flightId,
  );
  return rows.map((r) => ({
    ticketNo: r.ticket_no, seat: r.seat, status: r.status, boardedAt: r.boarded_at,
    name: `${r.last_name.toUpperCase()}, ${r.first_name}`, type: r.pax_type, pnr: r.pnr, tier: r.tier,
  }));
}

router.get('/flights/:id/manifest', requirePerm('gate'), h(async (req, c) => {
  const f = await getFlight(toId(req.params.id));
  if (!f) throw new HttpError(404, 'Flight not found');
  const list = await manifest(f.id);
  return c.json({
    flight: { ...flightView(f), capacity: seatLayout(f.aircraft).capacity.total },
    passengers: list,
    summary: { total: list.length, boarded: list.filter((p) => p.status === 'BOARDED').length },
  });
}));

router.post('/gate/scan', requirePerm('gate'), h(async (req, c) => {
  const parsed = parseBoardingCode(req.body?.code);
  const flightId = Number(req.body?.flightId) || null;
  if (!parsed) return c.json({ result: 'INVALID', message: 'Not an Adinkra Airways boarding code' });
  if (!parsed.valid) {
    await audit(req, 'gate.forged_code', { target: parsed.ticketNo, severity: 'high' });
    return c.json({ result: 'INVALID', message: 'QR signature check failed – possible forged ticket. Refer to supervisor.' });
  }
  const t = await one(
    `SELECT t.*, p.first_name, p.last_name, b.pnr, b.status AS bstatus, b.tier, bf.flight_id, f.flight_no, f.departure, r.origin, r.destination
     FROM tickets t JOIN passengers p ON p.id = t.passenger_id JOIN booking_flights bf ON bf.id = t.booking_flight_id
     JOIN bookings b ON b.id = bf.booking_id JOIN flights f ON f.id = bf.flight_id JOIN routes r ON r.id = f.route_id
     WHERE t.ticket_no = ?`,
    parsed.ticketNo,
  );
  if (!t) return c.json({ result: 'INVALID', message: 'Ticket number not found' });
  const pax = {
    name: `${t.last_name.toUpperCase()}, ${t.first_name}`, seat: t.seat, ticketNo: t.ticket_no, pnr: t.pnr,
    tier: TIERS[t.tier].label, flightNo: t.flight_no, route: `${t.origin} → ${t.destination}`, departure: t.departure,
  };
  if (flightId && t.flight_id !== flightId) {
    return c.json({ result: 'WRONG_FLIGHT', message: `This passenger is booked on ${t.flight_no} (${pax.route}), not this flight.`, passenger: pax });
  }
  if (t.status === 'CANCELLED' || t.bstatus !== 'CONFIRMED') return c.json({ result: 'REJECTED', message: 'Ticket is cancelled or unpaid – do not board', passenger: pax });
  if (t.status === 'BOARDED') return c.json({ result: 'DUPLICATE', message: `Already boarded at ${t.boarded_at.slice(11, 16)} GMT`, passenger: pax });
  const hrs = (Date.parse(t.departure) - Date.now()) / 3600000;
  if (hrs > 4 && !req.body?.override) {
    return c.json({ result: 'TOO_EARLY', message: `Flight departs in ${Math.round(hrs)} hours – boarding has not opened.`, passenger: pax });
  }
  // Only one scan can move a ticket to BOARDED, even if two agents scan at once.
  const upd = await run("UPDATE tickets SET status = 'BOARDED', boarded_at = ?, boarded_by = ? WHERE id = ? AND status = 'CONFIRMED'", nowIso(), req.user.id, t.id);
  if (!upd.changes) return c.json({ result: 'DUPLICATE', message: 'Already boarded', passenger: pax });
  await audit(req, 'gate.boarded', { target: t.ticket_no, details: { flight: t.flight_no, seat: t.seat } });
  return c.json({ result: 'BOARDED', message: 'Boarding confirmed – status updated from Confirmed to Boarded', passenger: pax });
}));

// ---------------- Booking desk ----------------
const bookingByPnr = async (req) => {
  const b = await one('SELECT * FROM bookings WHERE pnr = ?', String(req.params.pnr).toUpperCase());
  if (!b) throw new HttpError(404, 'No booking with that reference');
  return b;
};

router.get('/bookings/:pnr', requirePerm('bookings'), h(async (req, c) => {
  const b = await bookingByPnr(req);
  const reveal = req.query.reveal === '1' || (await setting('mask_pii_for_staff')) !== '1';
  if (reveal) await audit(req, 'pii.staff_access', { target: b.pnr, details: 'passport numbers revealed', severity: 'warn' });
  const owner = b.user_id ? await one('SELECT name, email, phone FROM users WHERE id = ?', b.user_id) : null;
  let quote = null;
  try { quote = await cancelQuote(b); } catch (e) { quote = { error: e.message }; }
  return c.json({ booking: await bookingDetail(b, { revealPII: reveal, withQr: false }), owner: owner || null, cancelQuote: quote });
}));

router.post('/bookings/:pnr/cancel', requirePerm('bookings'), h(async (req, c) => {
  const b = await bookingByPnr(req);
  if (!req.body?.identityVerified) throw bad('Confirm that you have verified the passenger’s identity');
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 4) throw bad('Enter a cancellation reason');
  const waive = !!req.body?.waive;
  const r = await cancelBooking(b, { actor: req.user.id, reason: `Staff: ${reason}`, waive });
  await audit(req, 'booking.staff_cancel', { target: b.pnr, details: { refund: r.refund, pct: r.pct, waive, reason }, severity: waive ? 'warn' : 'info' });
  return c.json({ ...r, booking: await bookingDetail(await one('SELECT * FROM bookings WHERE id = ?', b.id), { withQr: false }) });
}));

router.get('/bookings/:pnr/reroute-options', requirePerm('bookings'), h(async (req, c) => {
  const b = await bookingByPnr(req);
  return c.json(await changeOptions(b, req.query.segmentId, { staff: true }));
}));

router.post('/bookings/:pnr/reroute', requirePerm('bookings'), h(async (req, c) => {
  const b = await bookingByPnr(req);
  const reason = String(req.body?.reason || 'a schedule disruption').slice(0, 120);
  const r = await applyChange(b, req.body?.segmentId, req.body?.newFlightId, { staff: true, actor: req.user.id, reason });
  await audit(req, 'booking.reroute', { target: b.pnr, details: { to: r.flight.flightNo, seats: r.seats, reason } });
  return c.json({ ...r, booking: await bookingDetail(await one('SELECT * FROM bookings WHERE id = ?', b.id), { withQr: false }) });
}));

// ---------------- Cargo desk ----------------
async function cargoLoad(flightId) {
  return (await one("SELECT COALESCE(SUM(chargeable_kg), 0) AS kg FROM cargo WHERE flight_id = ? AND status NOT IN ('REJECTED','PENDING')", flightId)).kg;
}

router.get('/cargo', requirePerm('cargo'), h(async (req, c) => {
  const status = req.query.status;
  const [rows, countRows] = await Promise.all([
    all(`SELECT * FROM cargo ${status ? 'WHERE status = ?' : ''} ORDER BY CASE status WHEN 'PENDING' THEN 0 ELSE 1 END, id DESC LIMIT 200`, ...(status ? [status] : [])),
    all('SELECT status, COUNT(*) AS n FROM cargo GROUP BY status'),
  ]);
  return c.json({
    counts: Object.fromEntries(countRows.map((r) => [r.status, r.n])),
    shipments: rows.map((s) => ({
      awb: s.awb, status: s.status, origin: s.origin, destination: s.destination, shipper: s.shipper_name,
      description: s.description, type: CARGO_TYPES[s.cargo_type].label, pieces: s.pieces, weightKg: s.weight_kg,
      chargeableKg: s.chargeable_kg, price: s.price, createdAt: s.created_at,
    })),
  });
}));

router.get('/cargo/:awb', requirePerm('cargo'), h(async (req, c) => {
  const cg = await one('SELECT * FROM cargo WHERE awb = ?', req.params.awb);
  if (!cg) throw new HttpError(404, 'Shipment not found');
  const candidates = await queryFlights(
    `r.origin = ? AND r.destination = ? AND f.departure > ? AND f.status != 'CANCELLED' ORDER BY f.departure LIMIT 8`,
    cg.origin, cg.destination, new Date(Date.now() + 2 * 3600000).toISOString(),
  );
  const loads = await Promise.all(candidates.map((f) => cargoLoad(f.id)));
  const flights = candidates.map((f, i) => {
    const ac = AIRCRAFT[f.aircraft];
    const used = loads[i];
    const remaining = f.cargo_capacity_kg - used;
    const perPiece = cg.weight_kg / cg.pieces;
    const dims = [cg.length_cm, cg.width_cm, cg.height_cm].sort((a, b) => b - a);
    const lim = [...ac.maxPieceCm].sort((a, b) => b - a);
    const checks = [
      { label: `Hold capacity: ${remaining.toFixed(0)} kg free of ${f.cargo_capacity_kg} kg`, ok: remaining >= cg.chargeable_kg },
      { label: `Piece weight ${perPiece.toFixed(0)} kg ≤ ${ac.maxPieceKg} kg limit`, ok: perPiece <= ac.maxPieceKg },
      { label: `Dimensions ${dims.join('×')} cm fit door ${lim.join('×')} cm`, ok: dims.every((d, j) => d <= lim[j]) },
    ];
    return { id: f.id, flightNo: f.flight_no, departure: f.departure, aircraft: f.aircraft, capacityKg: f.cargo_capacity_kg, usedKg: used, remainingKg: remaining, checks, fits: checks.every((x) => x.ok) };
  });
  const [events, flight] = await Promise.all([
    all('SELECT status, note, created_at FROM cargo_events WHERE cargo_id = ? ORDER BY id', cg.id),
    cg.flight_id ? one('SELECT flight_no, departure FROM flights WHERE id = ?', cg.flight_id) : null,
  ]);
  return c.json({
    shipment: { ...cg, type: CARGO_TYPES[cg.cargo_type].label, events },
    flight: flight || null,
    flightOptions: flights,
  });
}));

router.post('/cargo/:awb/approve', requirePerm('cargo'), h(async (req, c) => {
  const cg = await one('SELECT * FROM cargo WHERE awb = ?', req.params.awb);
  if (!cg) throw new HttpError(404, 'Shipment not found');
  if (cg.status !== 'PENDING') throw bad('Only pending shipments can be approved');
  const f = await getFlight(toId(req.body?.flightId));
  if (!f || f.origin !== cg.origin || f.destination !== cg.destination) throw bad('Choose a flight on this route');
  const ac = AIRCRAFT[f.aircraft];
  if (cg.weight_kg / cg.pieces > ac.maxPieceKg) throw bad(`Pieces exceed the ${ac.maxPieceKg} kg per-piece limit of the ${f.aircraft}`);
  const dims = [cg.length_cm, cg.width_cm, cg.height_cm].sort((a, b) => b - a);
  const lim = [...ac.maxPieceCm].sort((a, b) => b - a);
  if (dims.some((d, i) => d > lim[i])) throw bad(`Pieces will not fit the ${f.aircraft} hold door`);
  await tx(async () => {
    // Lock the flight so two agents can't both fill the last of the hold capacity.
    await one('SELECT id FROM flights WHERE id = ? FOR UPDATE', f.id);
    const remaining = f.cargo_capacity_kg - (await cargoLoad(f.id));
    if (cg.chargeable_kg > remaining) throw bad(`Not enough hold capacity: ${remaining.toFixed(0)} kg free, shipment needs ${cg.chargeable_kg} kg`);
    const upd = await run("UPDATE cargo SET status = 'APPROVED', flight_id = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'", f.id, nowIso(), cg.id);
    if (!upd.changes) throw bad('Only pending shipments can be approved');
    await run('INSERT INTO cargo_events (cargo_id, status, note, actor_id) VALUES (?,?,?,?)', cg.id, 'APPROVED', `Space confirmed on ${f.flight_no} departing ${f.departure.slice(0, 16).replace('T', ' ')} GMT. Drop off at the cargo terminal at least 4 hours before.`, req.user.id);
  });
  await notify({ userId: cg.user_id, email: cg.shipper_email, phone: cg.shipper_phone, subject: `Cargo ${cg.awb} approved`, body: `Your shipment ${cg.awb} is booked on ${f.flight_no} (${f.departure.slice(0, 16).replace('T', ' ')} GMT). Amount payable at drop-off: GHS ${cg.price}.` });
  await audit(req, 'cargo.approve', { target: cg.awb, details: { flight: f.flight_no } });
  return c.json({ ok: true });
}));

router.post('/cargo/:awb/reject', requirePerm('cargo'), h(async (req, c) => {
  const cg = await one('SELECT * FROM cargo WHERE awb = ?', req.params.awb);
  if (!cg) throw new HttpError(404, 'Shipment not found');
  if (!['PENDING', 'APPROVED'].includes(cg.status)) throw bad('This shipment can no longer be rejected');
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 4) throw bad('Enter a reason');
  await tx(async () => {
    await run("UPDATE cargo SET status = 'REJECTED', notes = ?, updated_at = ? WHERE id = ?", reason, nowIso(), cg.id);
    await run('INSERT INTO cargo_events (cargo_id, status, note, actor_id) VALUES (?,?,?,?)', cg.id, 'REJECTED', reason, req.user.id);
  });
  await notify({ userId: cg.user_id, email: cg.shipper_email, phone: cg.shipper_phone, subject: `Cargo ${cg.awb} could not be accepted`, body: reason });
  await audit(req, 'cargo.reject', { target: cg.awb, details: reason });
  return c.json({ ok: true });
}));

const NEXT_STATUS = { APPROVED: 'RECEIVED', RECEIVED: 'IN_TRANSIT', IN_TRANSIT: 'ARRIVED', ARRIVED: 'DELIVERED' };
const STATUS_NOTE = {
  RECEIVED: 'Received and screened at the cargo terminal; payment collected',
  IN_TRANSIT: 'Loaded and departed',
  ARRIVED: 'Arrived at destination, ready for collection',
  DELIVERED: 'Collected by consignee',
};

router.post('/cargo/:awb/advance', requirePerm('cargo'), h(async (req, c) => {
  const cg = await one('SELECT * FROM cargo WHERE awb = ?', req.params.awb);
  if (!cg) throw new HttpError(404, 'Shipment not found');
  const next = NEXT_STATUS[cg.status];
  if (!next) throw bad(`No next step from ${cg.status}`);
  const note = String(req.body?.note || '').trim() || STATUS_NOTE[next];
  await tx(async () => {
    const upd = await run('UPDATE cargo SET status = ?, updated_at = ? WHERE id = ? AND status = ?', next, nowIso(), cg.id, cg.status);
    if (!upd.changes) throw new HttpError(409, 'This shipment was updated by someone else. Reload and try again.');
    await run('INSERT INTO cargo_events (cargo_id, status, note, actor_id) VALUES (?,?,?,?)', cg.id, next, note.slice(0, 200), req.user.id);
    if (next === 'RECEIVED') {
      await run(`INSERT INTO payments (cargo_id, kind, method, provider, amount, status, txn_ref, message) VALUES (?, 'CARGO', 'COUNTER', 'TERMINAL', ?, 'SUCCESS', ?, 'Paid at cargo terminal')`, cg.id, cg.price, `CGO_${cg.awb}`);
    }
  });
  await notify({ userId: cg.user_id, phone: cg.consignee_phone, subject: `Cargo ${cg.awb}: ${next.replace('_', ' ').toLowerCase()}`, body: `Shipment ${cg.awb} (${cg.origin}→${cg.destination}): ${note}` });
  await audit(req, 'cargo.status', { target: cg.awb, details: next });
  return c.json({ ok: true, status: next });
}));

// ---------------- Flight operations ----------------
router.put('/flights/:id/ops', requirePerm('ops'), h(async (req, c) => {
  const f = await getFlight(toId(req.params.id));
  if (!f) throw new HttpError(404, 'Flight not found');
  const delay = Math.max(0, Math.min(1440, Math.round(Number(req.body?.delayMin ?? f.delay_min) || 0)));
  const gate = String(req.body?.gate ?? f.gate ?? '').trim().toUpperCase().slice(0, 4) || null;
  const status = req.body?.status === 'CANCELLED' ? 'CANCELLED' : 'SCHEDULED';
  const remarks = String(req.body?.remarks ?? f.remarks ?? '').trim().slice(0, 120) || null;
  await run('UPDATE flights SET delay_min = ?, gate = ?, status = ?, remarks = ? WHERE id = ?', delay, gate, status, remarks, f.id);
  const changed = delay !== f.delay_min || status !== f.status;
  if (changed) {
    const pax = await all(
      `SELECT DISTINCT b.user_id, b.contact_email, b.contact_phone, b.pnr FROM bookings b JOIN booking_flights bf ON bf.booking_id = b.id
       WHERE bf.flight_id = ? AND b.status = 'CONFIRMED'`,
      f.id,
    );
    const msg = status === 'CANCELLED'
      ? `Flight ${f.flight_no} ${f.origin}→${f.destination} on ${f.departure.slice(0, 10)} has been cancelled. Our team will re-book you; you can also change for free under Manage Booking.`
      : `Flight ${f.flight_no} ${f.origin}→${f.destination} is now delayed by ${delay} minutes. New departure: ${new Date(Date.parse(f.departure) + delay * 60000).toISOString().slice(11, 16)} GMT.`;
    // One multi-row insert instead of two inserts per passenger.
    const rows = pax.flatMap((p) => [
      p.contact_email && [p.user_id, 'EMAIL', p.contact_email, `Flight update ${f.flight_no} – ${p.pnr}`, msg],
      p.contact_phone && [p.user_id, 'SMS', p.contact_phone, `Flight update ${f.flight_no} – ${p.pnr}`, msg.slice(0, 300)],
    ].filter(Boolean));
    if (rows.length) {
      await insertMany('notifications', ['user_id', 'channel', 'recipient', 'subject', 'body'], rows);
    }
  }
  await audit(req, 'flight.ops_update', { target: f.flight_no, details: { delay, gate, status, remarks }, severity: status === 'CANCELLED' ? 'warn' : 'info' });
  const updated = await getFlight(f.id);
  return c.json({ flight: { ...flightView(updated), live: liveStatus(updated) } });
}));

export default router;
