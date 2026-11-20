import { Hono } from 'hono';
import { h } from '../http.js';
import { one, all, run, insert } from '../db.js';
import { bad, HttpError, requireAuth, audit } from '../security.js';
import { CARGO_TYPES, cargoQuote, AIRCRAFT } from '../domain.js';
import { AIRPORT, randomCode, notify } from '../services.js';
import { EMAIL_RE, PHONE_RE, cleanPhone } from './auth.js';
import { AIRLINE } from '../config.js';

const router = new Hono();

async function parseShipment(body) {
  const { origin, destination, cargoType } = body || {};
  const route = await one('SELECT segment, aircraft FROM routes WHERE origin = ? AND destination = ? AND active = 1', String(origin || ''), String(destination || ''));
  if (!AIRPORT[origin] || !AIRPORT[destination] || !route) throw bad('We do not carry cargo on that route yet');
  if (!CARGO_TYPES[cargoType]) throw bad('Choose a cargo type');
  const num = (k, min, max, label) => {
    const v = Number(body[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw bad(`${label} must be between ${min} and ${max}`);
    return v;
  };
  return {
    origin, destination, cargoType, segment: route.segment, aircraft: route.aircraft,
    pieces: Math.round(num('pieces', 1, 50, 'Pieces')),
    weightKg: num('weightKg', 0.5, 5000, 'Weight (kg)'),
    lengthCm: num('lengthCm', 1, 300, 'Length (cm)'),
    widthCm: num('widthCm', 1, 250, 'Width (cm)'),
    heightCm: num('heightCm', 1, 200, 'Height (cm)'),
  };
}

/** Warnings if a piece will not fit the aircraft that operates the route. */
function fitWarnings(s) {
  const ac = AIRCRAFT[s.aircraft];
  const w = [];
  const perPiece = s.weightKg / s.pieces;
  if (perPiece > ac.maxPieceKg) w.push(`Each piece weighs ${perPiece.toFixed(0)} kg; the ${s.aircraft} accepts up to ${ac.maxPieceKg} kg per piece.`);
  const dims = [s.lengthCm, s.widthCm, s.heightCm].sort((a, b) => b - a);
  const lim = [...ac.maxPieceCm].sort((a, b) => b - a);
  if (dims.some((d, i) => d > lim[i])) w.push(`Pieces larger than ${lim.join(' × ')} cm won't fit the ${s.aircraft} hold door.`);
  return w;
}

router.get('/meta', h(async (_req, c) => {
  const routes = await all('SELECT origin, destination, segment FROM routes WHERE active = 1 ORDER BY origin, destination');
  return c.json({ types: CARGO_TYPES, routes: routes.map((r) => ({ ...r, originCity: AIRPORT[r.origin].city, destinationCity: AIRPORT[r.destination].city })) });
}));

router.post('/quote', h(async (req, c) => {
  const s = await parseShipment(req.body);
  return c.json({ quote: cargoQuote(s), segment: s.segment, aircraft: s.aircraft, warnings: fitWarnings(s) });
}));

router.post('/', h(async (req, c) => {
  const s = await parseShipment(req.body);
  const b = req.body;
  const shipperName = String(b.shipperName || '').trim();
  const consigneeName = String(b.consigneeName || '').trim();
  const shipperPhone = cleanPhone(b.shipperPhone);
  const consigneePhone = cleanPhone(b.consigneePhone);
  const shipperEmail = String(b.shipperEmail || req.user?.email || '').trim().toLowerCase();
  const description = String(b.description || '').trim();
  if (shipperName.length < 2 || consigneeName.length < 2) throw bad('Enter shipper and consignee names');
  if (!PHONE_RE.test(shipperPhone) || !PHONE_RE.test(consigneePhone)) throw bad('Enter valid shipper and consignee phone numbers');
  if (shipperEmail && !EMAIL_RE.test(shipperEmail)) throw bad('Enter a valid email');
  if (description.length < 3 || description.length > 200) throw bad('Describe the goods (3–200 characters)');
  if (/\b(explosive|firearm|gun|ammunition|lithium battery|flammable|gas cylinder)\b/i.test(description)) {
    throw bad('Dangerous goods cannot be booked online. Please visit the cargo terminal.');
  }
  const q = cargoQuote(s);
  let awb;
  do awb = `${AIRLINE.ticketPrefix}-${randomCode(8, '0123456789')}`;
  while (await one('SELECT 1 FROM cargo WHERE awb = ?', awb));
  const id = await insert(
    `INSERT INTO cargo (awb, user_id, shipper_name, shipper_phone, shipper_email, consignee_name, consignee_phone, origin, destination,
       description, cargo_type, pieces, weight_kg, length_cm, width_cm, height_cm, chargeable_kg, price, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING')`,
    awb, req.user?.id, shipperName, shipperPhone, shipperEmail || null, consigneeName, consigneePhone, s.origin, s.destination,
    description, s.cargoType, s.pieces, s.weightKg, s.lengthCm, s.widthCm, s.heightCm, q.chargeableKg, q.total,
  );
  await run('INSERT INTO cargo_events (cargo_id, status, note) VALUES (?,?,?)', id, 'PENDING', 'Booking request received online');
  await notify({
    userId: req.user?.id, email: shipperEmail || null, phone: shipperPhone,
    subject: `Cargo request ${awb} received`,
    body: `We have received your cargo request ${awb} (${s.origin}→${s.destination}, ${q.chargeableKg} kg chargeable, est. GHS ${q.total}). Our cargo team will confirm a flight shortly. Pay at drop-off.`,
  });
  await audit(req, 'cargo.request', { target: awb });
  return c.json({ awb, quote: q, warnings: fitWarnings(s) }, 201);
}));

router.get('/track/:awb', h(async (req, c) => {
  const cg = await one('SELECT * FROM cargo WHERE awb = ?', String(req.params.awb).trim());
  if (!cg) throw new HttpError(404, 'No shipment found with that air waybill number');
  const [f, events] = await Promise.all([
    cg.flight_id ? one('SELECT flight_no, departure, arrival FROM flights WHERE id = ?', cg.flight_id) : null,
    all('SELECT status, note, created_at FROM cargo_events WHERE cargo_id = ? ORDER BY id', cg.id),
  ]);
  return c.json({
    shipment: {
      awb: cg.awb, status: cg.status, origin: cg.origin, destination: cg.destination,
      originCity: AIRPORT[cg.origin].city, destinationCity: AIRPORT[cg.destination].city,
      pieces: cg.pieces, chargeableKg: cg.chargeable_kg, cargoType: CARGO_TYPES[cg.cargo_type].label,
      price: cg.price, flight: f || null, createdAt: cg.created_at, events,
    },
  });
}));

router.get('/mine', requireAuth, h(async (req, c) => c.json({
  shipments: await all('SELECT awb, origin, destination, status, chargeable_kg, price, created_at FROM cargo WHERE user_id = ? ORDER BY id DESC', req.user.id),
})));

export default router;
