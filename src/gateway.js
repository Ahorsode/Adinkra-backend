// Sandbox payment gateway.
//
// This mirrors the request/response shape of a Paystack-style charge so that a
// real provider can be dropped in behind `charge()` (set PAYSTACK_SECRET_KEY and
// call the provider's /charge endpoint). No money moves in this sandbox.
//
// Sandbox test values:
//   Mobile Money: any valid Ghana number; numbers ending in 0000 are declined.
//   Cards: any Luhn-valid number; 4000 0000 0000 0002 is declined.

import { randomCode } from './services.js';
import { bad } from './security.js';

export const MOMO_PROVIDERS = {
  MTN: { label: 'MTN MoMo', prefixes: ['024', '025', '053', '054', '055', '059'] },
  TELECEL: { label: 'Telecel Cash', prefixes: ['020', '050'] },
  AIRTELTIGO: { label: 'AT Money', prefixes: ['026', '027', '056', '057'] },
};

export function luhn(num) {
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function cardBrand(n) {
  if (/^4/.test(n)) return 'VISA';
  if (/^(5[1-5]|2[2-7])/.test(n)) return 'MASTERCARD';
  if (/^506[01]|^507[89]|^6500/.test(n)) return 'VERVE';
  return 'CARD';
}

/** Validates payment details and returns a gateway result. Throws 400 on bad input. */
export function charge({ method, provider, momoNumber, cardNumber, cardExpiry, cardCvv, cardName, amount }) {
  if (!(amount > 0)) throw bad('Invalid amount');
  const ref = `PSK_${randomCode(14, 'abcdefghijklmnopqrstuvwxyz0123456789')}`;
  if (method === 'MOMO') {
    const p = MOMO_PROVIDERS[provider];
    if (!p) throw bad('Choose a Mobile Money network');
    const num = String(momoNumber || '').replace(/\D/g, '').replace(/^233/, '0');
    if (!/^0\d{9}$/.test(num)) throw bad('Enter a valid 10-digit Ghana mobile number');
    if (!p.prefixes.includes(num.slice(0, 3))) throw bad(`${num.slice(0, 3)} is not a ${p.label} number`);
    const masked = `${num.slice(0, 3)} ••• ${num.slice(-4)}`;
    if (num.endsWith('0000')) return { ok: false, ref, method, provider, masked, message: 'Payment declined: insufficient wallet balance' };
    return { ok: true, ref, method, provider, masked, message: `Approved on ${p.label}` };
  }
  if (method === 'CARD') {
    const num = String(cardNumber || '').replace(/\D/g, '');
    if (num.length < 13 || num.length > 19 || !luhn(num)) throw bad('Card number is not valid');
    const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(String(cardExpiry || ''));
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) throw bad('Expiry must be MM/YY');
    const endOfMonth = new Date(Date.UTC(2000 + Number(m[2]), Number(m[1]), 1));
    if (endOfMonth < new Date()) throw bad('This card has expired');
    if (!/^\d{3,4}$/.test(String(cardCvv || ''))) throw bad('CVV must be 3 or 4 digits');
    if (!cardName || String(cardName).trim().length < 2) throw bad('Enter the name on the card');
    const brand = cardBrand(num);
    const masked = `${brand} •••• ${num.slice(-4)}`;
    if (num === '4000000000000002') return { ok: false, ref, method, provider: brand, masked, message: 'Card declined by issuer' };
    return { ok: true, ref, method, provider: brand, masked, message: 'Card payment approved (3-D Secure passed)' };
  }
  throw bad('Choose Mobile Money or Card');
}
