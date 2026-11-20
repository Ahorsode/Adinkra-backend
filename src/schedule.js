import { insertMany } from './db.js';
import { AIRCRAFT } from './domain.js';

const DAY = 86400000;
const GATES = { DOMESTIC: ['D1', 'D2', 'D3', 'D4'], REGIONAL: ['B1', 'B2', 'B3', 'B4', 'B5'], INTERNATIONAL: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'] };

export const isoDow = (d) => ((d.getUTCDay() + 6) % 7) + 1; // 1 = Monday … 7 = Sunday

export const FLIGHT_COLS = ['route_id', 'flight_no', 'departure', 'arrival', 'aircraft', 'base_price', 'gate', 'terminal', 'cargo_capacity_kg'];

/** Pure: the dated flights (FLIGHT_COLS order) a route operates between startOffset and endOffset days from today (UTC). */
export function flightRows(route, startOffset, endOffset, rand = Math.random) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const [hh, mm] = route.dep_time.split(':').map(Number);
  const rows = [];
  for (let d = startOffset; d <= endOffset; d++) {
    const day = new Date(today.getTime() + d * DAY);
    if (!route.days.includes(String(isoDow(day)))) continue;
    const dep = new Date(day.getTime() + (hh * 60 + mm) * 60000);
    const arr = new Date(dep.getTime() + route.duration_min * 60000);
    const gates = GATES[route.segment];
    rows.push([
      route.id, route.flight_no, dep.toISOString(), arr.toISOString(), route.aircraft, route.base_price,
      route.origin === 'ACC' ? gates[Math.floor(rand() * gates.length)] : String(1 + Math.floor(rand() * 9)),
      route.origin === 'ACC' ? (route.segment === 'DOMESTIC' ? 'T1' : 'T3') : null,
      AIRCRAFT[route.aircraft].cargoKg,
    ]);
  }
  return rows;
}

/**
 * Creates dated flights for a route between startOffset and endOffset days from today (UTC).
 * Existing flights are left untouched (UNIQUE flight_no + departure). Returns the new flight ids.
 */
export function generateFlights(route, startOffset, endOffset, rand = Math.random) {
  return insertMany('flights', FLIGHT_COLS, flightRows(route, startOffset, endOffset, rand), {
    onConflict: 'ON CONFLICT (flight_no, departure) DO NOTHING',
    returning: true,
  });
}
