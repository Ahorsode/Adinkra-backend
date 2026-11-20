// Derives a live operational status for a flight from its schedule, any
// operations override (delay / cancellation) and the current time.

const MIN = 60000;

export function liveStatus(f, now = Date.now()) {
  const delay = (f.delay_min || 0) * MIN;
  const std = Date.parse(f.departure);
  const sta = Date.parse(f.arrival);
  const etd = std + delay;
  const eta = sta + delay;
  const base = {
    scheduledDeparture: f.departure,
    scheduledArrival: f.arrival,
    estimatedDeparture: new Date(etd).toISOString(),
    estimatedArrival: new Date(eta).toISOString(),
    delayMin: f.delay_min || 0,
    gate: f.gate,
    terminal: f.terminal,
    remarks: f.remarks || null,
    progress: 0,
  };
  if (f.status === 'CANCELLED') return { ...base, code: 'CANCELLED', label: 'Cancelled', tone: 'bad' };
  if (now < etd - 45 * MIN) {
    return delay > 0
      ? { ...base, code: 'DELAYED', label: `Delayed ${f.delay_min} min`, tone: 'warn' }
      : { ...base, code: 'SCHEDULED', label: 'On time', tone: 'ok' };
  }
  if (now < etd - 15 * MIN) return { ...base, code: 'BOARDING', label: 'Boarding', tone: 'info' };
  if (now < etd) return { ...base, code: 'GATE_CLOSED', label: 'Gate closed', tone: 'info' };
  if (now < eta) {
    const progress = Math.min(0.99, (now - etd) / (eta - etd));
    return now - etd < 10 * MIN
      ? { ...base, code: 'DEPARTED', label: 'Departed', tone: 'info', progress }
      : { ...base, code: 'EN_ROUTE', label: 'In flight', tone: 'info', progress };
  }
  if (now < eta + 15 * MIN) return { ...base, code: 'LANDED', label: 'Landed', tone: 'ok', progress: 1 };
  return { ...base, code: 'ARRIVED', label: 'Arrived', tone: 'ok', progress: 1 };
}
