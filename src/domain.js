// Business rules shared by the API, seed data and PDF generator.

export const AIRPORTS = [
  ['ACC', 'Kotoka International Airport', 'Accra', 'Ghana', 'GH'],
  ['KMS', 'Prempeh I International Airport', 'Kumasi', 'Ghana', 'GH'],
  ['TML', 'Tamale International Airport', 'Tamale', 'Ghana', 'GH'],
  ['TKD', 'Takoradi Airport', 'Takoradi', 'Ghana', 'GH'],
  ['NYI', 'Sunyani Airport', 'Sunyani', 'Ghana', 'GH'],
  ['LOS', 'Murtala Muhammed International Airport', 'Lagos', 'Nigeria', 'WA'],
  ['ABV', 'Nnamdi Azikiwe International Airport', 'Abuja', 'Nigeria', 'WA'],
  ['ABJ', 'Félix Houphouët-Boigny International Airport', 'Abidjan', "Côte d'Ivoire", 'WA'],
  ['LFW', 'Gnassingbé Eyadéma International Airport', 'Lomé', 'Togo', 'WA'],
  ['DSS', 'Blaise Diagne International Airport', 'Dakar', 'Senegal', 'WA'],
  ['OUA', 'Ouagadougou Airport', 'Ouagadougou', 'Burkina Faso', 'WA'],
  ['FNA', 'Freetown International Airport', 'Freetown', 'Sierra Leone', 'WA'],
  ['ROB', 'Roberts International Airport', 'Monrovia', 'Liberia', 'WA'],
  ['COO', 'Cadjehoun Airport', 'Cotonou', 'Benin', 'WA'],
  ['LHR', 'Heathrow Airport', 'London', 'United Kingdom', 'INTL'],
  ['JFK', 'John F. Kennedy International Airport', 'New York', 'United States', 'INTL'],
  ['IAD', 'Washington Dulles International Airport', 'Washington, D.C.', 'United States', 'INTL'],
  ['DXB', 'Dubai International Airport', 'Dubai', 'United Arab Emirates', 'INTL'],
  ['JNB', 'O. R. Tambo International Airport', 'Johannesburg', 'South Africa', 'INTL'],
  ['CDG', 'Charles de Gaulle Airport', 'Paris', 'France', 'INTL'],
  ['NBO', 'Jomo Kenyatta International Airport', 'Nairobi', 'Kenya', 'INTL'],
];

const ZONE = Object.fromEntries(AIRPORTS.map((a) => [a[0], a[4]]));

/** Domestic = both in Ghana, Regional = both in ECOWAS West Africa, else International. */
export function segmentFor(origin, destination) {
  const a = ZONE[origin];
  const b = ZONE[destination];
  if (!a || !b) return null;
  if (a === 'GH' && b === 'GH') return 'DOMESTIC';
  if (a !== 'INTL' && b !== 'INTL') return 'REGIONAL';
  return 'INTERNATIONAL';
}

export const TIERS = {
  ECONOMY: { label: 'Economy', mult: 1 },
  BUSINESS: { label: 'Business', mult: 2.4 },
  FIRST: { label: 'First', mult: 4 },
};

// Cabin layouts: letters are seats, spaces are aisles.
export const AIRCRAFT = {
  'ATR 72-600': {
    cabins: [
      { tier: 'BUSINESS', from: 1, to: 2, layout: 'AC DF' },
      { tier: 'ECONOMY', from: 3, to: 17, layout: 'AC DF' },
    ],
    cargoKg: 1200,
    maxPieceKg: 100,
    maxPieceCm: [150, 100, 80],
  },
  'Boeing 737-800': {
    cabins: [
      { tier: 'BUSINESS', from: 1, to: 4, layout: 'AC DF' },
      { tier: 'ECONOMY', from: 5, to: 27, layout: 'ABC DEF' },
    ],
    cargoKg: 4000,
    maxPieceKg: 200,
    maxPieceCm: [200, 120, 85],
  },
  'Boeing 787-9': {
    cabins: [
      { tier: 'FIRST', from: 1, to: 2, layout: 'A DG K' },
      { tier: 'BUSINESS', from: 3, to: 7, layout: 'AC DG JK' },
      { tier: 'ECONOMY', from: 10, to: 29, layout: 'ABC DEFG HJK' },
    ],
    cargoKg: 15000,
    maxPieceKg: 1500,
    maxPieceCm: [300, 240, 160],
  },
};

const mapCache = new Map();

/** Seat map rows for an aircraft type, plus a seat -> tier lookup. */
export function seatLayout(aircraft) {
  if (mapCache.has(aircraft)) return mapCache.get(aircraft);
  const cfg = AIRCRAFT[aircraft];
  if (!cfg) throw new Error(`Unknown aircraft ${aircraft}`);
  const rows = [];
  const tierOf = new Map();
  const capacity = { ECONOMY: 0, BUSINESS: 0, FIRST: 0, total: 0 };
  for (const cabin of cfg.cabins) {
    for (let r = cabin.from; r <= cabin.to; r++) {
      const groups = cabin.layout.split(' ').map((g) => g.split('').map((l) => `${r}${l}`));
      for (const g of groups) for (const s of g) tierOf.set(s, cabin.tier);
      const n = groups.flat().length;
      capacity[cabin.tier] += n;
      capacity.total += n;
      rows.push({ row: r, tier: cabin.tier, groups });
    }
  }
  const out = { rows, tierOf, capacity, tiers: cfg.cabins.map((c) => c.tier) };
  mapCache.set(aircraft, out);
  return out;
}

export const roundTo5 = (n) => Math.round(n / 5) * 5;

/** Fare per passenger; rises gently as the cabin fills (simple yield management). */
export function fareFor(basePrice, tier, loadFactor = 0) {
  return roundTo5(basePrice * TIERS[tier].mult * (1 + 0.25 * Math.min(1, Math.max(0, loadFactor))));
}

/** Government taxes + airport/passenger service charges per passenger. */
export function taxesFor(segment, fare) {
  return Math.round(fare * 0.12 + (segment === 'DOMESTIC' ? 30 : 120));
}

export const CHANGE_FEE = { DOMESTIC: 80, REGIONAL: 200, INTERNATIONAL: 400 };

/** Refund percentage based on hours remaining before the first unflown departure. */
export function refundPolicy(hoursToDeparture) {
  if (hoursToDeparture >= 168) return { pct: 90, rule: 'More than 7 days before departure: 90% refund' };
  if (hoursToDeparture >= 72) return { pct: 50, rule: '3–7 days before departure: 50% refund' };
  if (hoursToDeparture >= 24) return { pct: 25, rule: '24–72 hours before departure: 25% refund' };
  return { pct: 0, rule: 'Less than 24 hours before departure: non-refundable' };
}

export const BAGGAGE = {
  DOMESTIC: {
    ECONOMY: { checked: '1 × 20 kg', cabin: '7 kg' },
    BUSINESS: { checked: '1 × 30 kg', cabin: '10 kg' },
  },
  REGIONAL: {
    ECONOMY: { checked: '1 × 23 kg', cabin: '7 kg' },
    BUSINESS: { checked: '2 × 32 kg', cabin: '10 kg' },
  },
  INTERNATIONAL: {
    ECONOMY: { checked: '2 × 23 kg', cabin: '7 kg' },
    BUSINESS: { checked: '2 × 32 kg', cabin: '2 × 10 kg' },
    FIRST: { checked: '3 × 32 kg', cabin: '2 × 10 kg' },
  },
};

export const CARGO_TYPES = {
  GENERAL: { label: 'General goods', surcharge: 1.0 },
  PERISHABLE: { label: 'Perishables (food, flowers)', surcharge: 1.25 },
  FRAGILE: { label: 'Fragile items', surcharge: 1.15 },
  VALUABLE: { label: 'Valuables / documents', surcharge: 1.5 },
  PHARMA: { label: 'Pharmaceuticals (temperature controlled)', surcharge: 1.35 },
};

export const CARGO_RATES = {
  DOMESTIC: { perKg: 9, minimum: 120 },
  REGIONAL: { perKg: 28, minimum: 400 },
  INTERNATIONAL: { perKg: 52, minimum: 800 },
};

export const CARGO_STATUSES = ['PENDING', 'APPROVED', 'RECEIVED', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED', 'REJECTED'];

/** Cargo quote with volumetric (dimensional) weight, IATA divisor 6000. */
export function cargoQuote({ segment, weightKg, lengthCm, widthCm, heightCm, pieces, cargoType }) {
  const rate = CARGO_RATES[segment];
  const type = CARGO_TYPES[cargoType];
  const volumetricKg = +((lengthCm * widthCm * heightCm * pieces) / 6000).toFixed(1);
  const chargeableKg = Math.max(weightKg, volumetricKg);
  const freight = Math.max(rate.minimum, chargeableKg * rate.perKg * type.surcharge);
  const fuel = freight * 0.08;
  const security = 25 + pieces * 5;
  const handling = 50;
  const total = Math.round(freight + fuel + security + handling);
  return {
    volumetricKg,
    actualKg: weightKg,
    chargeableKg: +chargeableKg.toFixed(1),
    ratePerKg: +(rate.perKg * type.surcharge).toFixed(2),
    lines: [
      { label: `Freight (${chargeableKg.toFixed(1)} kg chargeable)`, amount: Math.round(freight) },
      { label: 'Fuel surcharge (8%)', amount: Math.round(fuel) },
      { label: 'Security screening', amount: security },
      { label: 'Terminal handling', amount: handling },
    ],
    total,
  };
}

export const STAFF_PERMISSIONS = {
  support: 'Customer support tickets',
  gate: 'Gate boarding & scanning',
  bookings: 'Booking cancellations & re-routing',
  cargo: 'Cargo intake & tracking',
  ops: 'Flight operations (delays, gates)',
};

export const SUPPORT_CATEGORIES = {
  BAGGAGE: 'Baggage',
  BOOKING: 'Booking & tickets',
  REFUND: 'Refunds & payments',
  CARGO: 'Cargo',
  FLIGHT: 'Flight disruption',
  OTHER: 'Other',
};
