// Smoke test against a running API (wrangler dev or the deployed site):
//   node scripts/smoke.js http://127.0.0.1:8787
//   node scripts/smoke.js https://your-site.vercel.app
// Read-mostly: it signs in, searches, opens seeded bookings, downloads an e-ticket and loads dashboards.
const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');

function client() {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const t = Date.now();
    const res = await fetch(base + path, {
      method,
      // Browsers send Origin on POSTs; Neon Auth only accepts its trusted domains.
      headers: { 'X-Requested-With': 'fetch', Origin: new URL(base).origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    // Keep every cookie (Neon Auth sets a session token and a cached-session cookie).
    const jar = new Map(cookie ? cookie.split('; ').map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]) : []);
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(';')[0];
      const i = pair.indexOf('=');
      if (pair.slice(i + 1)) jar.set(pair.slice(0, i), pair.slice(i + 1));
      else jar.delete(pair.slice(0, i));
    }
    cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
    console.log(`${String(res.status).padEnd(4)} ${String(Date.now() - t).padStart(5)} ms  ${method} ${path}`);
    if (res.status >= 500) throw new Error(JSON.stringify(data));
    return { status: res.status, data };
  };
}

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const fail = (msg) => { throw new Error(msg); };

const call = client();
(await call('GET', '/api/health')).data.ok || fail('health');
const login = await call('POST', '/api/auth/login', { email: 'kwame.mensah@example.com', password: 'Traveler@2026' });
login.status === 200 || fail('login');
const s = await call('GET', `/api/flights/search?from=ACC&to=LHR&date=${day(5)}&pax=1`);
s.status === 200 || fail('search');
await call('GET', '/api/bookings/mine');
const b = await call('GET', '/api/bookings/KWM7KS');
b.data.booking?.passengers?.[0]?.tickets?.[0]?.qr?.startsWith('data:image/png') || fail('QR missing');
const pdf = await call('GET', '/api/bookings/KWM7KS/eticket.pdf');
new TextDecoder().decode(pdf.data.slice(0, 4)) === '%PDF' || fail('PDF');
await call('GET', '/api/profile');
await call('GET', '/api/flights/board?airport=ACC');

const admin = client();
(await admin('POST', '/api/auth/login', { email: 'kojo.addo@adinkra-air.test', password: 'Admin@2026' })).status === 200 || fail('admin login');
const an = await admin('GET', '/api/admin/analytics?days=90');
an.data.kpis?.grossRevenue > 0 || fail('analytics');
await admin('GET', '/api/admin/occupancy?window=past30');
const sec = await admin('GET', '/api/admin/security');
sec.data.checks?.every((c) => c.ok) || fail(`security checks: ${JSON.stringify(sec.data.checks?.filter((c) => !c.ok))}`);
await admin('GET', '/api/staff/flights');
console.log('\nSmoke test passed.');
