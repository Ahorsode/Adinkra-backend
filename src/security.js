import crypto from 'node:crypto';
import { keys } from './config.js';
import { one, run, settingNum } from './db.js';
import { neonAuth, hasAuthCookie } from './neonauth.js';

const dataKey = () => Buffer.from(keys().dataKey, 'hex');
const hmacKey = () => Buffer.from(keys().hmacKey, 'hex');

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const bad = (msg, extra) => new HttpError(400, msg, extra);

// ---------- Passwords ----------
// Passwords are stored and checked by Neon Auth (see neonauth.js); this is the app's own policy,
// enforced before a password is sent there.
export async function passwordProblem(pw) {
  const min = await settingNum('password_min_length');
  if (typeof pw !== 'string' || pw.length < min) return `Password must be at least ${min} characters`;
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers';
  return null;
}

// ---------- Field encryption (AES-256-GCM) for PII ----------
export function encrypt(text) {
  if (text == null || text === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dataKey(), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
export function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const d = crypto.createDecipheriv('aes-256-gcm', dataKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
export const keyFingerprint = () =>
  crypto.createHash('sha256').update(dataKey()).digest('hex').slice(0, 16).match(/.{4}/g).join(':');

export function mask(value, keep = 3) {
  if (!value) return null;
  const s = String(value);
  return '•'.repeat(Math.max(0, s.length - keep)) + s.slice(-keep);
}

// ---------- Tokens & signatures ----------
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (s) => crypto.createHmac('sha256', hmacKey()).update(s).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Short-lived token proving the holder looked the booking up with PNR + surname. */
export function bookingToken(pnr, ttlMin = 120) {
  const exp = Date.now() + ttlMin * 60000;
  return `${pnr}.${exp}.${hmac(`bk|${pnr}|${exp}`).slice(0, 32)}`;
}
export function verifyBookingToken(token, pnr) {
  if (!token) return false;
  const [p, exp, sig] = String(token).split('.');
  if (p !== pnr || !exp || Number(exp) < Date.now()) return false;
  return safeEqual(sig, hmac(`bk|${p}|${exp}`).slice(0, 32));
}

/** Data encoded in the e-ticket / boarding pass QR code. */
export const boardingCode = (ticketNo) => `ADK1.${ticketNo}.${hmac(`bp|${ticketNo}`).slice(0, 16)}`;
export function parseBoardingCode(code) {
  const c = String(code || '').trim();
  const m = /^ADK1\.(\d{13})\.([a-f0-9]{16})$/.exec(c);
  if (m) return { ticketNo: m[1], signed: true, valid: safeEqual(m[2], hmac(`bp|${m[1]}`).slice(0, 16)) };
  const digits = c.replace(/[\s-]/g, '');
  if (/^\d{13}$/.test(digits)) return { ticketNo: digits, signed: false, valid: true };
  return null;
}

// ---------- Sessions ----------
export const SESSION_COOKIE = 'adk_sid';

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch { /* ignore malformed cookie */ }
    }
  }
  return out;
}

/** The app profile (role, permissions, active flag) linked to a Neon Auth user id. */
export const appUserFor = (authUserId) =>
  one('SELECT id, name, email, role, permissions, active FROM users WHERE auth_user_id = ?', authUserId);

/**
 * Resolves the signed-in user from the Neon Auth session cookies, then applies the app's own rules:
 * the account must be linked and active, and the session must be younger than the admin's
 * "session timeout" setting (Neon Auth sessions themselves last 7 days).
 */
export async function loadUser(req) {
  if (!hasAuthCookie(req.get('cookie'))) return null;
  const { data, error } = await neonAuth().getSession();
  if (error) {
    console.error('Neon Auth getSession failed', error.code, error.message);
    return null;
  }
  if (!data?.user || !data.session) return null;
  const u = await appUserFor(data.user.id);
  if (!u || !u.active) return null;
  const hours = await settingNum('session_timeout_hours');
  if (Date.parse(data.session.createdAt) + hours * 3600000 < Date.now()) return null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, permissions: JSON.parse(u.permissions), authUserId: data.user.id };
}

// ---------- Role-based access control (Hono middleware) ----------
export function hasPerm(user, perm) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.role === 'staff' && user.permissions.includes(perm);
}
export const requireAuth = async (c, next) => {
  if (!c.get('req').user) throw new HttpError(401, 'Please sign in to continue');
  await next();
};
export const requireRole = (...roles) => async (c, next) => {
  const req = c.get('req');
  if (!req.user) throw new HttpError(401, 'Please sign in to continue');
  if (!roles.includes(req.user.role)) {
    await audit(req, 'rbac.denied', { target: req.originalUrl, severity: 'warn' });
    throw new HttpError(403, 'You do not have access to this area');
  }
  await next();
};
export const requirePerm = (perm) => async (c, next) => {
  const req = c.get('req');
  if (!req.user) throw new HttpError(401, 'Please sign in to continue');
  if (!hasPerm(req.user, perm)) {
    await audit(req, 'rbac.denied', { target: req.originalUrl, details: `missing permission: ${perm}`, severity: 'warn' });
    throw new HttpError(403, `Your account lacks the "${perm}" permission`);
  }
  await next();
};

// ---------- Audit log ----------
export async function audit(req, action, { target = null, details = null, severity = 'info', userId } = {}) {
  await run(
    'INSERT INTO audit_log (user_id, action, target, details, severity, ip) VALUES (?,?,?,?,?,?)',
    userId ?? req?.user?.id ?? null,
    action,
    target,
    details == null ? null : typeof details === 'string' ? details : JSON.stringify(details),
    severity,
    req?.ip ?? null,
  );
}

// ---------- Rate limiting (shared across Worker isolates via the database) ----------
export function makeLimiter(name, { max, windowMs }) {
  const k = (key) => `${name}|${key}`;
  return {
    async blocked(key) {
      const h = await one('SELECT count, until_ms FROM rate_limits WHERE key = ?', k(key));
      return h && h.count >= max && h.until_ms > Date.now() ? Math.ceil((h.until_ms - Date.now()) / 60000) : 0;
    },
    async hit(key) {
      const now = Date.now();
      const r = await one(
        `INSERT INTO rate_limits (key, count, until_ms) VALUES (?, 1, ?)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN rate_limits.until_ms < ? THEN 1 ELSE rate_limits.count + 1 END,
           until_ms = CASE WHEN rate_limits.until_ms < ? THEN excluded.until_ms ELSE rate_limits.until_ms END
         RETURNING count`,
        k(key), now + windowMs, now, now,
      );
      return r.count;
    },
    async reset(key) {
      await run('DELETE FROM rate_limits WHERE key = ?', k(key));
    },
  };
}

// ---------- HTTP hardening ----------
export async function securityHeaders(c, next) {
  await next();
  const h = c.res.headers;
  h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cache-Control', 'no-store');
}

/** State-changing API calls must carry a custom header, which cross-site forms cannot send. */
export function csrfCheck(req) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.get('x-requested-with') !== 'fetch') {
    throw new HttpError(403, 'Missing request header');
  }
}
