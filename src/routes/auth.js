import { Hono } from 'hono';
import { h, toId } from '../http.js';
import { one, run, insert, nowIso, settingNum } from '../db.js';
import {
  HttpError, bad, hashPassword, verifyPassword, passwordProblem, encrypt, createSession, destroySession,
  audit, makeLimiter,
} from '../security.js';

const router = new Hono();
const loginLimiter = makeLimiter('login', { max: 5, windowMs: 15 * 60000 });

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const PHONE_RE = /^\+?\d{9,15}$/;
export const GHANA_CARD_RE = /^GHA-\d{9}-\d$/;
export const cleanPhone = (p) => String(p || '').replace(/[\s()-]/g, '');

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role,
  permissions: Array.isArray(u.permissions) ? u.permissions : JSON.parse(u.permissions || '[]'),
});

router.post('/register', h(async (req, c) => {
  const { name, email, phone, nationalId, password } = req.body || {};
  const n = String(name || '').trim();
  const e = String(email || '').trim().toLowerCase();
  const ph = cleanPhone(phone);
  const gc = String(nationalId || '').trim().toUpperCase();
  if (n.length < 2 || n.length > 80) throw bad('Enter your full name');
  if (!EMAIL_RE.test(e)) throw bad('Enter a valid email address');
  if (!PHONE_RE.test(ph)) throw bad('Enter a valid phone number');
  if (!GHANA_CARD_RE.test(gc)) throw bad('Ghana Card number must look like GHA-123456789-0');
  const pwErr = await passwordProblem(password);
  if (pwErr) throw bad(pwErr);
  if (await one('SELECT 1 FROM users WHERE email = ?', e)) throw new HttpError(409, 'An account with this email already exists');
  const ff = `ADK${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const id = await insert(
    `INSERT INTO users (name, email, phone, national_id_enc, password_hash, role, frequent_flyer_no) VALUES (?,?,?,?,?, 'traveler', ?)`,
    n, e, ph, encrypt(gc), await hashPassword(password), ff,
  );
  await createSession(req, id);
  await audit(req, 'auth.register', { target: e, userId: id });
  return c.json({ user: publicUser({ id, name: n, email: e, role: 'traveler', permissions: [] }) }, 201);
}));

router.post('/login', h(async (req, c) => {
  const e = String(req.body?.email || '').trim().toLowerCase();
  const pw = String(req.body?.password || '');
  const key = `${req.ip}|${e}`;
  const wait = await loginLimiter.blocked(key);
  if (wait) throw new HttpError(429, `Too many failed attempts. Try again in ${wait} minute(s).`);
  const u = await one('SELECT * FROM users WHERE email = ?', e);
  if (!u || !(await verifyPassword(pw, u.password_hash))) {
    const count = await loginLimiter.hit(key);
    const max = await settingNum('max_login_attempts');
    await audit(req, 'auth.login_failed', { target: e, severity: count >= max ? 'high' : 'warn', details: `attempt ${count}` });
    if (count >= max) await audit(req, 'auth.lockout', { target: e, severity: 'high' });
    throw new HttpError(401, 'Incorrect email or password');
  }
  if (!u.active) {
    await audit(req, 'auth.login_inactive', { target: e, severity: 'warn', userId: u.id });
    throw new HttpError(403, 'This account has been deactivated. Contact an administrator.');
  }
  await loginLimiter.reset(key);
  await createSession(req, u.id);
  await run('UPDATE users SET last_login = ? WHERE id = ?', nowIso(), u.id);
  await audit(req, 'auth.login', { target: e, userId: u.id });
  return c.json({ user: publicUser(u) });
}));

router.post('/logout', h(async (req, c) => {
  if (req.user) await audit(req, 'auth.logout');
  await destroySession(req);
  return c.json({ ok: true });
}));

router.get('/me', h((req, c) => c.json({ user: req.user ? publicUser(req.user) : null })));

export default router;
