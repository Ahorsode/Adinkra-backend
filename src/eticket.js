// PDF e-ticket, drawn with pdf-lib (runs on Workers: no filesystem, standard PDF fonts only).
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';
import { AIRLINE } from './config.js';
import { AIRPORT } from './services.js';

// Brand palette: royal/midnight blue structure with a gold accent.
const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const NAVY = hex('#0f2a55');
const BLUE = hex('#1d4886');
const GOLD = hex('#fcb130');
const INK = hex('#16213a');
const MUTED = hex('#586379');
const LIGHT = hex('#c3d1ea');
const BORDER = hex('#cfd8d3');
const WHITE = rgb(1, 1, 1);

const A4 = [595.28, 841.89];

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

/** Standard fonts use WinAnsi encoding; replace anything outside it so drawing never throws. */
const ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const safe = (s) => Array.from(String(s ?? '')).map((ch) => {
  const code = ch.codePointAt(0);
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || ANSI_EXTRA.has(ch) ? ch : '?';
}).join('');

/** Renders the booking's e-tickets (one coupon per passenger per flight) as PDF bytes. */
export async function renderETicket(detail) {
  const doc = await PDFDocument.create();
  doc.setTitle(`E-ticket ${detail.pnr}`);
  doc.setAuthor(AIRLINE.name);
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.CourierBold),
  };
  let page = doc.addPage(A4);
  const H = A4[1];

  // Helpers that take top-left coordinates like the original PDFKit layout.
  const text = (str, x, top, { font = fonts.regular, size = 10, color = INK, width, align = 'left' } = {}) => {
    const s = safe(str);
    let dx = 0;
    if (width && align !== 'left') {
      const w = font.widthOfTextAtSize(s, size);
      dx = align === 'right' ? width - w : (width - w) / 2;
    }
    page.drawText(s, { x: x + dx, y: H - top - size * 0.78, size, font, color });
  };
  const rect = (x, top, w, hgt, color) => page.drawRectangle({ x, y: H - top - hgt, width: w, height: hgt, color });
  const line = (x1, y1, x2, y2, color, thickness = 1.5) =>
    page.drawLine({ start: { x: x1, y: H - y1 }, end: { x: x2, y: H - y2 }, thickness, color });
  const wrap = (str, font, size, width) => {
    const lines = [];
    let cur = '';
    for (const word of safe(str).split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && cur) {
        lines.push(cur);
        cur = word;
      } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  /** QR code as vector squares (sharp at any zoom, no PNG encoding needed). */
  const qr = (data, x, top, size) => {
    const { modules } = QRCode.create(data, { errorCorrectionLevel: 'M' });
    const n = modules.size + 2; // 1-module quiet zone each side
    const cell = size / n;
    rect(x, top, size, size, WHITE);
    for (let r = 0; r < modules.size; r++) {
      for (let col = 0; col < modules.size; col++) {
        if (modules.get(r, col)) rect(x + (col + 1) * cell, top + (r + 1) * cell, cell + 0.05, cell + 0.05, INK);
      }
    }
  };

  // Header
  rect(0, 0, A4[0], 90, NAVY);
  rect(0, 90, A4[0], 4, GOLD);
  text(AIRLINE.name, 40, 28, { font: fonts.bold, size: 22, color: WHITE });
  text('Electronic ticket & itinerary receipt', 40, 56, { size: 10, color: LIGHT });
  text('BOOKING REFERENCE', 400, 28, { font: fonts.bold, size: 10, color: WHITE, width: 155, align: 'right' });
  text(detail.pnr, 400, 44, { font: fonts.mono, size: 24, color: GOLD, width: 155, align: 'right' });

  let y = 110;
  text(`Cabin: ${detail.tierLabel}    Trip: ${detail.tripType === 'ROUND_TRIP' ? 'Return' : 'One way'}    Status: ${detail.status}`, 40, y);
  y += 16;
  text(`Baggage allowance per passenger: checked ${detail.baggage.checked}, cabin ${detail.baggage.cabin}`, 40, y, { color: MUTED });
  y += 26;

  for (const seg of detail.segments) {
    for (const p of detail.passengers) {
      const t = p.tickets.find((x) => x.segmentId === seg.segmentId);
      if (!t || t.status === 'CANCELLED') continue;
      if (y > 620) {
        page = doc.addPage(A4);
        y = 40;
      }
      const hgt = 170;
      page.drawRectangle({ x: 40, y: H - y - hgt, width: 515, height: hgt, borderColor: BORDER, borderWidth: 1 });
      rect(40, y, 6, hgt, GOLD);

      text('PASSENGER', 60, y + 14, { size: 8, color: MUTED });
      text(`${p.lastName.toUpperCase()} / ${p.firstName.toUpperCase()}`, 60, y + 25, { font: fonts.bold, size: 13 });
      text('FLIGHT', 300, y + 14, { size: 8, color: MUTED });
      text(seg.flightNo, 300, y + 25, { font: fonts.bold, size: 13 });

      const o = AIRPORT[seg.origin];
      const d = AIRPORT[seg.destination];
      text(seg.origin, 60, y + 52, { font: fonts.bold, size: 26, color: BLUE });
      text(o?.city || '', 60, y + 82, { size: 9, color: MUTED });
      // Standard PDF fonts have no arrow glyph, so draw one.
      line(136, y + 68, 160, y + 68, MUTED);
      line(154, y + 63, 161, y + 68, MUTED);
      line(161, y + 68, 154, y + 73, MUTED);
      text(seg.destination, 175, y + 52, { font: fonts.bold, size: 26, color: BLUE });
      text(d?.city || '', 175, y + 82, { size: 9, color: MUTED });

      const cols = [
        ['DATE', fmtDate(seg.departure)],
        ['DEPARTS (GMT)', fmtTime(seg.departure)],
        ['ARRIVES (GMT)', fmtTime(seg.arrival)],
        ['SEAT', t.seat],
      ];
      const xs = [60, 180, 270, 360];
      cols.forEach(([label, val], i) => {
        text(label, xs[i], y + 104, { size: 8, color: MUTED });
        text(val, xs[i], y + 116, { font: fonts.bold, size: 11 });
      });
      text(`E-TICKET ${t.ticketNo}   ·   ${seg.aircraft}   ·   Gate closes 15 min before departure`, 60, y + 145, { size: 8, color: MUTED });

      qr(t.code, 430, y + 14, 112);
      text('Scan at the boarding gate', 430, y + 130, { size: 7, color: MUTED, width: 112, align: 'center' });
      y += hgt + 14;
    }
  }

  if (y > 700) {
    page = doc.addPage(A4);
    y = 40;
  }
  const footer =
    `Total paid: GHS ${detail.paid.toFixed(2)}. Present this e-ticket with a valid Ghana Card or passport at check-in. ` +
    'Check-in closes 60 minutes (domestic) or 3 hours (international) before departure. All times are GMT.';
  wrap(footer, fonts.regular, 8, 515).forEach((l, i) => text(l, 40, y + 6 + i * 10, { size: 8, color: MUTED }));

  return doc.save();
}
