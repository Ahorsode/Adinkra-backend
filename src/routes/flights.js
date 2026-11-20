import { Hono } from 'hono';
import { h, toId } from '../http.js';
import { all, one, nowIso } from '../db.js';
import { bad, HttpError } from '../security.js';
import { seatLayout, TIERS, BAGGAGE } from '../domain.js';
import { AIRPORT, getFlight, queryFlights, flightView, flightViewsWithAvailability, takenSeats, expireHolds } from '../services.js';
import { liveStatus } from '../status.js';

const router = new Hono();
const DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/airports', h(async (_req, c) => {
  const served = await all('SELECT origin, destination FROM routes WHERE active = 1');
  const dest = {};
  for (const r of served) (dest[r.origin] ||= new Set()).add(r.destination);
  return c.json({
    airports: Object.values(AIRPORT).map((a) => ({ ...a, served: !!dest[a.code], destinations: [...(dest[a.code] || [])] })),
  });
}));

async function dayFlights(from, to, date, pax) {
  const start = `${date}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + DAY).toISOString();
  const minDep = new Date(Date.now() + 60 * 60000).toISOString();
  const flights = await queryFlights(
    `r.origin = ? AND r.destination = ? AND f.departure >= ? AND f.departure < ? AND f.departure > ? AND r.active = 1 ORDER BY f.departure`,
    from, to, start, end, minDep,
  );
  return (await flightViewsWithAvailability(flights))
    .map((v) => ({ ...v, bookable: v.live.code !== 'CANCELLED' && v.tiers.some((t) => t.available >= pax) }));
}

async function nearbyDates(from, to, date) {
  const rows = await all(
    `SELECT d FROM (
       SELECT substr(f.departure, 1, 10) AS d FROM flights f JOIN routes r ON r.id = f.route_id
       WHERE r.origin = ? AND r.destination = ? AND r.active = 1 AND f.status != 'CANCELLED' AND f.departure > ?
       GROUP BY 1
     ) x ORDER BY abs(d::date - ?::date) LIMIT 6`,
    from, to, nowIso(), date,
  );
  return rows.map((r) => r.d).sort();
}

router.get('/search', h(async (req, c) => {
  await expireHolds();
  const { from, to, date, returnDate } = req.query;
  const pax = Math.max(1, Math.min(9, Number(req.query.pax) || 1));
  if (!AIRPORT[from] || !AIRPORT[to]) throw bad('Choose valid origin and destination airports');
  if (from === to) throw bad('Origin and destination must differ');
  if (!DATE_RE.test(String(date))) throw bad('Choose a departure date');
  if (returnDate && (!DATE_RE.test(String(returnDate)) || returnDate < date)) throw bad('Return date must be on or after the departure date');
  const route = await one('SELECT segment FROM routes WHERE origin = ? AND destination = ? AND active = 1', from, to);
  if (!route) {
    return c.json({ outbound: [], inbound: [], noRoute: true, message: `We don't currently fly ${AIRPORT[from].city} → ${AIRPORT[to].city}.` });
  }
  const [outbound, inbound] = await Promise.all([
    dayFlights(from, to, date, pax),
    returnDate ? dayFlights(to, from, returnDate, pax) : [],
  ]);
  return c.json({
    segment: route.segment,
    pax,
    outbound,
    inbound,
    suggestions: {
      outbound: outbound.length ? [] : await nearbyDates(from, to, date),
      inbound: returnDate && !inbound.length ? await nearbyDates(to, from, returnDate) : [],
    },
    baggage: BAGGAGE[route.segment],
  });
}));

router.get('/schedule', h(async (req, c) => {
  const segment = req.query.segment;
  const rows = await all(
    `SELECT r.*, (SELECT MIN(f.departure) FROM flights f WHERE f.route_id = r.id AND f.departure > ? AND f.status != 'CANCELLED') AS next_departure
     FROM routes r WHERE r.active = 1 ${segment ? 'AND r.segment = ?' : ''} ORDER BY r.segment, r.flight_no`,
    nowIso(), ...(segment ? [segment] : []),
  );
  return c.json({
    routes: rows.map((r) => ({
      id: r.id,
      flightNo: r.flight_no,
      origin: r.origin,
      destination: r.destination,
      originCity: AIRPORT[r.origin]?.city,
      destinationCity: AIRPORT[r.destination]?.city,
      segment: r.segment,
      depTime: r.dep_time,
      durationMin: r.duration_min,
      days: r.days,
      aircraft: r.aircraft,
      fromPrice: r.base_price,
      nextDeparture: r.next_departure,
    })),
  });
}));

/** Live flight status by flight number (+date) or by route. */
router.get('/status', h(async (req, c) => {
  const flightNo = String(req.query.flightNo || '').toUpperCase().replace(/\s/g, '');
  const date = DATE_RE.test(String(req.query.date)) ? req.query.date : new Date().toISOString().slice(0, 10);
  const start = new Date(Date.parse(`${date}T00:00:00Z`) - 6 * 3600000).toISOString();
  const end = new Date(Date.parse(`${date}T00:00:00Z`) + 30 * 3600000).toISOString();
  let rows;
  if (flightNo) {
    if (!/^[A-Z]{2}\d{2,4}$/.test(flightNo)) throw bad('Flight numbers look like AD201');
    rows = await queryFlights('f.flight_no = ? AND f.departure >= ? AND f.departure < ? ORDER BY f.departure', flightNo, start, end);
  } else if (req.query.from && req.query.to) {
    rows = await queryFlights('r.origin = ? AND r.destination = ? AND f.departure >= ? AND f.departure < ? ORDER BY f.departure', req.query.from, req.query.to, start, end);
  } else throw bad('Enter a flight number or choose a route');
  return c.json({ date, flights: rows.map((f) => flightView(f)) });
}));

/** Airport departures/arrivals board for the next/last few hours. */
router.get('/board', h(async (req, c) => {
  const airport = AIRPORT[req.query.airport] ? req.query.airport : 'ACC';
  const type = req.query.type === 'arrivals' ? 'arrivals' : 'departures';
  const from = new Date(Date.now() - 3 * 3600000).toISOString();
  const to = new Date(Date.now() + 18 * 3600000).toISOString();
  const col = type === 'arrivals' ? 'f.arrival' : 'f.departure';
  const where = type === 'arrivals' ? 'r.destination = ?' : 'r.origin = ?';
  const rows = await queryFlights(`${where} AND ${col} >= ? AND ${col} < ? ORDER BY ${col} LIMIT 30`, airport, from, to);
  return c.json({
    airport: AIRPORT[airport],
    type,
    flights: rows.map((f) => ({ ...flightView(f), live: liveStatus(f) })),
  });
}));

router.get('/:id/seats', h(async (req, c) => {
  await expireHolds();
  const f = await getFlight(toId(req.params.id));
  if (!f) throw new HttpError(404, 'Flight not found');
  const layout = seatLayout(f.aircraft);
  const taken = await takenSeats(f.id);
  return c.json({
    flight: flightView(f, taken),
    rows: layout.rows.map((r) => ({
      row: r.row,
      tier: r.tier,
      groups: r.groups.map((g) => g.map((s) => ({ id: s, taken: taken.has(s) }))),
    })),
    tiers: layout.tiers.map((t) => ({ tier: t, label: TIERS[t].label })),
  });
}));

export default router;
