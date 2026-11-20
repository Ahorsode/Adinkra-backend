// Sign-up, sign-in and password reset through Neon Auth (Managed Better Auth).
// The website calls these app endpoints; they call Neon Auth server-to-server and then apply
// the app's own rules (Ghana Card, roles and permissions, lockout, audit log).
import { Hono } from 'hono';
import { h } from '../http.js';
import { one, run, insert, nowIso, settingNum } from '../db.js';
import { HttpError, bad, passwordProblem, encrypt, audit, makeLimiter, appUserFor } from '../security.js';
import { neonAuth, clearAuthCookies, authFailure, config as authConfig } from '../neonauth.js';
import { processAuthMiddleware, DEFAULT_AUTH_SKIP_ROUTES } from '@neon/auth/server';

const router = new Hono();
const loginLimiter = makeLimiter('login', { max: 5, windowMs: 15 * 60000 });
const resetLimiter = makeLimiter('reset', { max: 5, windowMs: 15 * 60000 });

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const PHONE_RE = /^\+?\d{9,15}$/;
export const GHANA_CARD_RE = /^GHA-\d{9}-\d$/;
export const cleanPhone = (p) => String(p || '').replace(/[\s()-]/g, '');

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role,
  permissions: Array.isArray(u.permissions) ? u.permissions : JSON.parse(u.permissions || '[]'),
  // Google sign-ups still owe a phone number and Ghana Card (the website asks once).
  needsProfile: !!(u.needsProfile ?? u.needs_profile),
});

/** Only same-site hash routes like "/trips" or "/book?x=1" may be used as a post-login destination. */
const safeNext = (v) => (typeof v === 'string' && /^\/(?!\/)[\w\-/?=&%.]*$/.test(v) && v.length <= 200 ? v : '/trips');

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

  // Neon Auth creates the identity and signs the new user in (session cookies on this response).
  const { data, error } = await neonAuth().signUp.email({ email: e, password, name: n });
  if (error) {
    if (/already exists/i.test(error.message || '')) throw new HttpError(409, 'An account with this email already exists');
    throw authFailure(error, 'Could not create your account. Please try again.');
  }
  const ff = `ADK${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const id = await insert(
    `INSERT INTO users (name, email, phone, national_id_enc, auth_user_id, role, frequent_flyer_no) VALUES (?,?,?,?,?, 'traveler', ?)`,
    n, e, ph, encrypt(gc), data.user.id, ff,
  );
  await audit(req, 'auth.register', { target: e, userId: id });
  return c.json({ user: publicUser({ id, name: n, email: e, role: 'traveler', permissions: [] }) }, 201);
}));

router.post('/login', h(async (req, c) => {
  const e = String(req.body?.email || '').trim().toLowerCase();
  const pw = String(req.body?.password || '');
  const key = `${req.ip}|${e}`;
  const wait = await loginLimiter.blocked(key);
  if (wait) throw new HttpError(429, `Too many failed attempts. Try again in ${wait} minute(s).`);

  const { data, error } = await neonAuth().signIn.email({ email: e, password: pw });
  if (error && error.status === 401) {
    const count = await loginLimiter.hit(key);
    const max = await settingNum('max_login_attempts');
    await audit(req, 'auth.login_failed', { target: e, severity: count >= max ? 'high' : 'warn', details: `attempt ${count}` });
    if (count >= max) await audit(req, 'auth.lockout', { target: e, severity: 'high' });
    throw new HttpError(401, 'Incorrect email or password');
  }
  if (error) throw authFailure(error);

  // Link the Neon Auth identity to the app profile (first sign-in of a pre-existing profile links by email).
  let u = await appUserFor(data.user.id);
  if (!u) {
    const byEmail = await one('SELECT id FROM users WHERE email = ? AND auth_user_id IS NULL', e);
    if (byEmail) {
      await run('UPDATE users SET auth_user_id = ? WHERE id = ?', data.user.id, byEmail.id);
      u = await appUserFor(data.user.id);
    }
  }
  if (!u) {
    clearAuthCookies(c);
    await audit(req, 'auth.login_unlinked', { target: e, severity: 'warn' });
    throw new HttpError(403, 'This account is not set up for Adinkra Airways. Please register first.');
  }
  if (!u.active) {
    clearAuthCookies(c);
    await audit(req, 'auth.login_inactive', { target: e, severity: 'warn', userId: u.id });
    throw new HttpError(403, 'This account has been deactivated. Contact an administrator.');
  }
  await loginLimiter.reset(key);
  await run('UPDATE users SET last_login = ? WHERE id = ?', nowIso(), u.id);
  await audit(req, 'auth.login', { target: e, userId: u.id });
  return c.json({ user: publicUser(u) });
}));

router.post('/logout', h(async (req, c) => {
  if (req.user) await audit(req, 'auth.logout');
  const { error } = await neonAuth().signOut();
  if (error) console.error('Neon Auth signOut failed', error.code, error.message);
  clearAuthCookies(c);
  return c.json({ ok: true });
}));

router.get('/me', h((req, c) => c.json({ user: req.user ? publicUser(req.user) : null })));

// ---------- Continue with Google (Neon Auth social sign-in) ----------
// 1. POST /google      → Neon Auth returns Google's URL and sets a short-lived challenge cookie.
// 2. Google → Neon Auth → GET /callback?neon_auth_session_verifier=… on this site; the toolkit
//    exchanges the verifier + challenge cookie for a first-party session.
// 3. The website calls POST /oauth-finish, which links or creates the Adinkra profile.
router.post('/google', h(async (req, c) => {
  const origin = req.get('origin');
  if (!origin) throw bad('Missing Origin header');
  const next = safeNext(req.body?.next);
  const { data, error } = await neonAuth().signIn.social({
    provider: 'google',
    callbackURL: `${origin}/api/auth/callback?next=${encodeURIComponent(next)}`,
  });
  if (error || !data?.url) throw authFailure(error, 'Google sign-in is not available right now. Please use your email and password.');
  await audit(req, 'auth.google_start', { target: origin });
  return c.json({ url: data.url });
}));

router.get('/callback', async (c) => {
  const req = c.get('req');
  const next = safeNext(req.query.next);
  const fail = (why) => {
    console.warn('Google sign-in callback failed:', why);
    return c.redirect(`/#/login?error=google&next=${encodeURIComponent(next)}`, 302);
  };
  if (req.query.error) return fail(String(req.query.error).slice(0, 80));
  const { baseUrl, cookieSecret } = authConfig();
  const result = await processAuthMiddleware({
    request: c.req.raw,
    pathname: '/api/auth/callback',
    skipRoutes: DEFAULT_AUTH_SKIP_ROUTES,
    loginUrl: '/__adinkra-login-page', // never matches; the exchange is all we need here
    baseUrl,
    cookieSecret,
  });
  if (result.action !== 'redirect_oauth') return fail(`no verifier exchange (${result.action})`);
  for (const cookie of result.cookies) c.header('Set-Cookie', cookie, { append: true });
  return c.redirect(`/#/oauth-finish?next=${encodeURIComponent(next)}`, 302);
});

router.post('/oauth-finish', h(async (req, c) => {
  const { data, error } = await neonAuth().getSession();
  if (error || !data?.user) throw new HttpError(401, 'Google sign-in did not finish. Please try again.');
  const nu = data.user;
  const email = String(nu.email || '').trim().toLowerCase();
  let u = await appUserFor(nu.id);
  let created = false;
  if (!u) {
    const byEmail = await one('SELECT id, auth_user_id FROM users WHERE email = ?', email);
    if (byEmail && !byEmail.auth_user_id && nu.emailVerified) {
      await run('UPDATE users SET auth_user_id = ? WHERE id = ?', nu.id, byEmail.id);
    } else if (byEmail) {
      clearAuthCookies(c);
      await audit(req, 'auth.google_conflict', { target: email, severity: 'warn' });
      throw new HttpError(409, 'An Adinkra Airways account already uses this email. Sign in with your password instead.');
    } else {
      if (!EMAIL_RE.test(email)) throw bad('Your Google account has no usable email address');
      const name = String(nu.name || email.split('@')[0]).trim().slice(0, 80) || 'Traveller';
      const ff = `ADK${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
      const id = await insert(
        `INSERT INTO users (name, email, auth_user_id, role, frequent_flyer_no) VALUES (?,?,?, 'traveler', ?)`,
        name, email, nu.id, ff,
      );
      created = true;
      await audit(req, 'auth.register', { target: email, userId: id, details: 'google' });
    }
    u = await appUserFor(nu.id);
  }
  if (!u.active) {
    clearAuthCookies(c);
    await audit(req, 'auth.login_inactive', { target: email, severity: 'warn', userId: u.id });
    throw new HttpError(403, 'This account has been deactivated. Contact an administrator.');
  }
  await run('UPDATE users SET last_login = ? WHERE id = ?', nowIso(), u.id);
  await audit(req, 'auth.login', { target: email, userId: u.id, details: 'google' });
  return c.json({ user: publicUser(u), created });
}));

// ---------- Forgotten password: 6-digit code by email (Neon Auth email OTP) ----------
router.post('/forgot-password', h(async (req, c) => {
  const e = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw bad('Enter a valid email address');
  if (await resetLimiter.blocked(`send|${req.ip}`)) throw new HttpError(429, 'Too many requests. Please wait a few minutes.');
  await resetLimiter.hit(`send|${req.ip}`);
  const u = await one('SELECT id, active FROM users WHERE email = ?', e);
  // Only send codes to active Adinkra accounts, but answer the same way either way (no account probing).
  if (u?.active) {
    const { error } = await neonAuth().emailOtp.sendVerificationOtp({ email: e, type: 'forget-password' });
    if (error) console.error('Neon Auth could not send the reset code', error.code, error.message);
    await audit(req, 'auth.reset_requested', { target: e, userId: u.id });
  }
  return c.json({ ok: true, message: 'If that email has an Adinkra Airways account, a 6-digit code is on its way.' });
}));

router.post('/reset-password', h(async (req, c) => {
  const e = String(req.body?.email || '').trim().toLowerCase();
  const otp = String(req.body?.code || '').replace(/\s/g, '');
  const password = req.body?.password;
  if (!EMAIL_RE.test(e)) throw bad('Enter a valid email address');
  if (!/^\d{6}$/.test(otp)) throw bad('Enter the 6-digit code from the email');
  const pwErr = await passwordProblem(password);
  if (pwErr) throw bad(pwErr);
  const key = `verify|${req.ip}|${e}`;
  if (await resetLimiter.blocked(key)) throw new HttpError(429, 'Too many attempts. Request a new code in a few minutes.');
  const { error } = await neonAuth().emailOtp.resetPassword({ email: e, otp, password });
  if (error) {
    await resetLimiter.hit(key);
    await audit(req, 'auth.reset_failed', { target: e, severity: 'warn' });
    if (error.status && error.status < 500) throw bad('That code is incorrect or has expired. Request a new one.');
    throw authFailure(error);
  }
  await resetLimiter.reset(key);
  await audit(req, 'auth.password_reset', { target: e, severity: 'warn' });
  return c.json({ ok: true, message: 'Password updated. You can sign in with your new password.' });
}));

export default router;
