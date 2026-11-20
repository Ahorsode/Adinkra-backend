import { Hono } from 'hono';
import { h } from '../http.js';
import { one, all, run, insert, nowIso } from '../db.js';
import { bad, HttpError, requireAuth, hasPerm, audit } from '../security.js';
import { SUPPORT_CATEGORIES, BAGGAGE } from '../domain.js';
import { randomCode } from '../services.js';

const router = new Hono();

router.get('/meta', (c) => c.json({ categories: SUPPORT_CATEGORIES, baggage: BAGGAGE }));

router.use('*', requireAuth);

export async function ticketView(t, { staff = false } = {}) {
  const [messages, owner, assignee] = await Promise.all([
    all(
      `SELECT m.body, m.author_role, m.created_at, u.name AS author FROM ticket_messages m LEFT JOIN users u ON u.id = m.author_id
       WHERE m.ticket_id = ? ORDER BY m.id`,
      t.id,
    ),
    one('SELECT name, email FROM users WHERE id = ?', t.user_id),
    t.assigned_to ? one('SELECT name FROM users WHERE id = ?', t.assigned_to) : null,
  ]);
  return {
    ref: t.ref, category: t.category, categoryLabel: SUPPORT_CATEGORIES[t.category], subject: t.subject, pnr: t.pnr,
    status: t.status, createdAt: t.created_at, updatedAt: t.updated_at,
    customer: staff ? owner : { name: owner.name },
    assignedTo: assignee?.name ?? null,
    messages: messages.map((m) => ({ ...m, author: m.author_role === 'customer' ? m.author : `${m.author} (Adinkra support)` })),
  };
}

router.get('/', h(async (req, c) => {
  const rows = await all('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC', req.user.id);
  return c.json({ tickets: rows.map((t) => ({ ref: t.ref, subject: t.subject, status: t.status, category: SUPPORT_CATEGORIES[t.category], updatedAt: t.updated_at })) });
}));

router.post('/', h(async (req, c) => {
  const { category, subject, message, pnr } = req.body || {};
  const s = String(subject || '').trim();
  const m = String(message || '').trim();
  if (!SUPPORT_CATEGORIES[category]) throw bad('Choose a category');
  if (s.length < 4 || s.length > 120) throw bad('Subject must be 4–120 characters');
  if (m.length < 10 || m.length > 4000) throw bad('Message must be 10–4000 characters');
  const p = String(pnr || '').trim().toUpperCase();
  if (p && !/^[A-Z0-9]{6}$/.test(p)) throw bad('Booking reference is 6 letters/digits');
  let ref;
  do ref = `SR-${randomCode(6, '0123456789')}`;
  while (await one('SELECT 1 FROM support_tickets WHERE ref = ?', ref));
  const id = await insert('INSERT INTO support_tickets (ref, user_id, category, subject, pnr) VALUES (?,?,?,?,?)', ref, req.user.id, category, s, p || null);
  await run('INSERT INTO ticket_messages (ticket_id, author_id, author_role, body) VALUES (?,?,?,?)', id, req.user.id, 'customer', m);
  await audit(req, 'support.create', { target: ref });
  return c.json({ ticket: await ticketView(await one('SELECT * FROM support_tickets WHERE id = ?', id)) }, 201);
}));

async function loadTicket(req) {
  const t = await one('SELECT * FROM support_tickets WHERE ref = ?', String(req.params.ref).toUpperCase());
  if (!t || (t.user_id !== req.user.id && !hasPerm(req.user, 'support'))) throw new HttpError(404, 'Ticket not found');
  return t;
}

router.get('/:ref', h(async (req, c) => c.json({ ticket: await ticketView(await loadTicket(req)) })));

router.post('/:ref/messages', h(async (req, c) => {
  const t = await loadTicket(req);
  const m = String(req.body?.message || '').trim();
  if (m.length < 2 || m.length > 4000) throw bad('Message must be 2–4000 characters');
  await run('INSERT INTO ticket_messages (ticket_id, author_id, author_role, body) VALUES (?,?,?,?)', t.id, req.user.id, 'customer', m);
  await run(`UPDATE support_tickets SET status = CASE WHEN status IN ('RESOLVED','CLOSED') THEN 'OPEN' ELSE status END, updated_at = ? WHERE id = ?`, nowIso(), t.id);
  return c.json({ ticket: await ticketView(await one('SELECT * FROM support_tickets WHERE id = ?', t.id)) });
}));

export default router;
