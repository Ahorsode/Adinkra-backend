import { Hono } from 'hono';
import { h } from '../http.js';
import { one, all, run } from '../db.js';
import { bad, HttpError, requireAuth, encrypt, decrypt, mask, passwordProblem, audit } from '../security.js';
import { neonAuth, authFailure } from '../neonauth.js';
import { PHONE_RE, GHANA_CARD_RE, cleanPhone } from './auth.js';

const router = new Hono();
router.use('*', requireAuth);

async function profileOf(id) {
  const [u, t] = await Promise.all([
    one('SELECT * FROM users WHERE id = ?', id),
    one(
      `SELECT COUNT(*) AS n FROM tickets t JOIN passengers p ON p.id = t.passenger_id JOIN bookings b ON b.id = p.booking_id
       WHERE b.user_id = ? AND t.status = 'BOARDED'`,
      id,
    ),
  ]);
  const trips = t.n;
  return {
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    nationalId: mask(decrypt(u.national_id_enc), 4),
    passport: mask(decrypt(u.passport_enc)),
    hasPassport: !!u.passport_enc,
    passportExpiry: u.passport_expiry,
    nationality: u.nationality,
    dob: u.dob,
    frequentFlyerNo: u.frequent_flyer_no,
    loyaltyTier: trips >= 20 ? 'Gold' : trips >= 8 ? 'Silver' : 'Blue',
    flightsFlown: trips,
    emergency: { name: u.emergency_name, relation: u.emergency_relation, phone: u.emergency_phone },
    memberSince: u.created_at,
  };
}

router.get('/', h(async (req, c) => c.json({ profile: await profileOf(req.user.id) })));

router.put('/', h(async (req, c) => {
  const b = req.body || {};
  const name = String(b.name ?? '').trim();
  const phone = cleanPhone(b.phone);
  if (name.length < 2 || name.length > 80) throw bad('Enter your full name');
  if (!PHONE_RE.test(phone)) throw bad('Enter a valid phone number');
  const passport = String(b.passportNo || '').trim().toUpperCase().replace(/\s/g, '');
  if (passport && !/^[A-Z0-9]{6,12}$/.test(passport)) throw bad('Passport number must be 6–12 letters/digits');
  if (b.passportExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(b.passportExpiry)) throw bad('Invalid passport expiry date');
  if (b.dob && !/^\d{4}-\d{2}-\d{2}$/.test(b.dob)) throw bad('Invalid date of birth');
  const ff = String(b.frequentFlyerNo || '').trim().toUpperCase();
  if (ff && !/^[A-Z0-9]{6,12}$/.test(ff)) throw bad('Frequent flyer number must be 6–12 letters/digits');
  const em = b.emergency || {};
  const emPhone = cleanPhone(em.phone);
  if (emPhone && !PHONE_RE.test(emPhone)) throw bad('Enter a valid emergency contact phone');
  const current = await one('SELECT passport_enc FROM users WHERE id = ?', req.user.id);
  await run(
    `UPDATE users SET name = ?, phone = ?, passport_enc = ?, passport_expiry = ?, nationality = ?, dob = ?, frequent_flyer_no = ?,
       emergency_name = ?, emergency_relation = ?, emergency_phone = ? WHERE id = ?`,
    name, phone, passport ? encrypt(passport) : current.passport_enc, b.passportExpiry || null,
    String(b.nationality || '').slice(0, 40) || null, b.dob || null, ff || null,
    String(em.name || '').slice(0, 80) || null, String(em.relation || '').slice(0, 40) || null, emPhone || null, req.user.id,
  );
  await audit(req, 'profile.update', { target: req.user.email, details: { passportChanged: !!passport } });
  return c.json({ profile: await profileOf(req.user.id) });
}));

/** First visit after "Continue with Google": the phone number and Ghana Card normal registration asks for. */
router.put('/complete', h(async (req, c) => {
  const phone = cleanPhone(req.body?.phone);
  const gc = String(req.body?.nationalId || '').trim().toUpperCase();
  if (!PHONE_RE.test(phone)) throw bad('Enter a valid phone number');
  if (!GHANA_CARD_RE.test(gc)) throw bad('Ghana Card number must look like GHA-123456789-0');
  await run('UPDATE users SET phone = ?, national_id_enc = ? WHERE id = ?', phone, encrypt(gc), req.user.id);
  await audit(req, 'profile.complete', { target: req.user.email });
  return c.json({ ok: true, profile: await profileOf(req.user.id) });
}));

/** Returns the saved passport (decrypted) so the booking form can prefill it for the account holder. */
router.get('/travel-document', h(async (req, c) => {
  const u = await one('SELECT passport_enc, passport_expiry, nationality, dob, name FROM users WHERE id = ?', req.user.id);
  await audit(req, 'pii.self_access', { target: 'passport' });
  return c.json({ passportNo: decrypt(u.passport_enc), passportExpiry: u.passport_expiry, nationality: u.nationality, dob: u.dob, name: u.name });
}));

router.put('/password', h(async (req, c) => {
  const { currentPassword, newPassword } = req.body || {};
  const err = await passwordProblem(newPassword);
  if (err) throw bad(err);
  // Neon Auth checks the current password, stores the new one and signs out the user's other devices.
  const { error } = await neonAuth().changePassword({ currentPassword: String(currentPassword || ''), newPassword, revokeOtherSessions: true });
  if (error) {
    if (error.status === 400 || error.status === 401) throw new HttpError(401, 'Current password is incorrect');
    throw authFailure(error, 'Could not change your password. Please try again.');
  }
  await audit(req, 'auth.password_change', { severity: 'warn' });
  return c.json({ ok: true });
}));

router.get('/notifications', h(async (req, c) => c.json({
  notifications: await all('SELECT channel, recipient, subject, body, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', req.user.id),
})));

export default router;
