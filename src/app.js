import { Hono } from 'hono';
import { AIRLINE } from './config.js';
import { HttpError, loadUser, securityHeaders, csrfCheck } from './security.js';
import { withAuthContext } from './neonauth.js';
import liveRoutes from './routes/live.js';
import authRoutes from './routes/auth.js';
import flightRoutes from './routes/flights.js';
import bookingRoutes from './routes/bookings.js';
import profileRoutes from './routes/profile.js';
import cargoRoutes from './routes/cargo.js';
import supportRoutes from './routes/support.js';
import staffRoutes from './routes/staff.js';
import adminRoutes from './routes/admin.js';

const MAX_BODY = 100 * 1024;

/** Client IP: the Vercel proxy puts the visitor's address first in X-Forwarded-For. */
function clientIp(c) {
  const xff = c.req.header('x-forwarded-for');
  return (xff && xff.split(',')[0].trim()) || c.req.header('x-real-ip') || c.req.header('cf-connecting-ip') || '127.0.0.1';
}

/**
 * Builds the small request object the route handlers use (user, ip, body, query, params, get()),
 * so handlers read much like the original Express code. `req.c` is the Hono context.
 */
async function buildReq(c) {
  const url = new URL(c.req.url);
  const req = {
    c,
    method: c.req.method,
    path: url.pathname,
    originalUrl: url.pathname + url.search,
    ip: clientIp(c),
    secure: url.protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https',
    get: (name) => c.req.header(name),
    query: Object.fromEntries(url.searchParams),
    body: {},
    user: null,
  };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const text = await c.req.text();
    if (text.length > MAX_BODY) throw new HttpError(413, 'Request body too large');
    if (text && (c.req.header('content-type') || '').includes('json')) {
      try {
        req.body = JSON.parse(text);
      } catch {
        throw new HttpError(400, 'Malformed JSON body');
      }
    }
  }
  return req;
}

export function createApp() {
  const app = new Hono();
  app.use('*', securityHeaders);
  // Every API request runs with Neon Auth bound to it (cookies in, Set-Cookie out).
  app.use('/api/*', (c, next) => withAuthContext(c, async () => {
    const req = await buildReq(c);
    c.set('req', req);
    csrfCheck(req);
    req.user = await loadUser(req);
    await next();
  }));

  app.get('/api/health', (c) => c.json({ ok: true, airline: AIRLINE.name, time: new Date().toISOString() }));
  app.route('/api/auth', authRoutes);
  app.route('/api/flights', flightRoutes);
  app.route('/api/bookings', bookingRoutes);
  app.route('/api/profile', profileRoutes);
  app.route('/api/cargo', cargoRoutes);
  app.route('/api/support', supportRoutes);
  app.route('/api/staff', staffRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/live', liveRoutes);

  app.notFound((c) => c.json({ error: 'Not found' }, 404));
  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    return c.json(
      { error: status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message, ...(err.extra || {}) },
      status,
    );
  });
  return app;
}
