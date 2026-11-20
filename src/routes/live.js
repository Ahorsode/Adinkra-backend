// Neon Realtime: sealed live queries for the public flight status page and airport board.
//
// The browser subscribes to these over Neon's Live SQL WebSocket. Each query watches only the
// operational columns staff change (status, delay, gate, remarks) for the flights on screen;
// when any of them changes, the page refetches its normal API data, so rendering logic stays
// in one place. Sealed queries expire after ~60 s and the browser renews them through the
// same endpoint, so the parameters must come out identical within a window: times are rounded
// to the hour and derived only from validated inputs.
import { Hono } from 'hono';
import { createRealtime, rawSql } from '@neon/realtime/server';
import { h } from '../http.js';
import { envVar } from '../config.js';
import { HttpError, bad } from '../security.js';
import { AIRPORT } from '../services.js';

const router = new Hono();
const HOUR = 3600000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLS = 'f.id, f.status, f.delay_min, f.gate, f.remarks';

let cached = null;
function realtime() {
  const secret = envVar('NEON_REALTIME_SECRET');
  const url = envVar('NEON_REALTIME_URL');
  if (!secret || !url) throw new HttpError(503, 'Live updates are not available right now');
  const db = envVar('NEON_REALTIME_DB') || 'neondb';
  if (!cached || cached.key !== secret + url + db) cached = { key: secret + url + db, url, server: createRealtime({ secret, db }) };
  return cached;
}

const iso = (ms) => new Date(ms).toISOString();

async function sealed(c, query) {
  const rt = realtime();
  const s = await rt.server.seal({ query });
  return c.json({ url: rt.url, sealed: s });
}

/** Airport departures/arrivals board: same airport and roughly the same window as GET /api/flights/board. */
router.get('/board', h(async (req, c) => {
  const airport = AIRPORT[req.query.airport] ? req.query.airport : 'ACC';
  const arrivals = req.query.type === 'arrivals';
  const hour = Math.floor(Date.now() / HOUR) * HOUR;
  const from = iso(hour - 3 * HOUR);
  const to = iso(hour + 19 * HOUR);
  const query = arrivals
    ? rawSql(`SELECT ${COLS} FROM flights f JOIN routes r ON r.id = f.route_id WHERE r.destination = $1 AND f.arrival >= $2 AND f.arrival < $3`, [airport, from, to])
    : rawSql(`SELECT ${COLS} FROM flights f JOIN routes r ON r.id = f.route_id WHERE r.origin = $1 AND f.departure >= $2 AND f.departure < $3`, [airport, from, to]);
  return sealed(c, query);
}));

/** Flight status search: the same flights GET /api/flights/status returns for these inputs. */
router.get('/status', h(async (req, c) => {
  const flightNo = String(req.query.flightNo || '').toUpperCase().replace(/\s/g, '');
  const date = DATE_RE.test(String(req.query.date)) ? req.query.date : new Date().toISOString().slice(0, 10);
  const start = iso(Date.parse(`${date}T00:00:00Z`) - 6 * HOUR);
  const end = iso(Date.parse(`${date}T00:00:00Z`) + 30 * HOUR);
  if (flightNo) {
    if (!/^[A-Z]{2}\d{2,4}$/.test(flightNo)) throw bad('Flight numbers look like AD201');
    return sealed(c, rawSql(`SELECT ${COLS} FROM flights f WHERE f.flight_no = $1 AND f.departure >= $2 AND f.departure < $3`, [flightNo, start, end]));
  }
  const { from, to } = req.query;
  if (!AIRPORT[from] || !AIRPORT[to]) throw bad('Enter a flight number or choose a route');
  return sealed(c, rawSql(
    `SELECT ${COLS} FROM flights f JOIN routes r ON r.id = f.route_id WHERE r.origin = $1 AND r.destination = $2 AND f.departure >= $3 AND f.departure < $4`,
    [from, to, start, end],
  ));
}));

export default router;
