// Copies the Worker's Neon settings from a Neon env file into .dev.vars, keeping everything else there.
//   npm run secrets:sync               # from .env (the production branch that `neon link` pulled)
//   node scripts/sync-neon-env.js .env.dev   # point local `wrangler dev` at the dev branch instead
// Also generates NEON_AUTH_COOKIE_SECRET once (signs Neon Auth's cached-session cookie).
// Then `npm run secrets:upload` sends .dev.vars to the deployed Worker as secrets.
import fs from 'node:fs';
import crypto from 'node:crypto';

const source = process.argv[2] || '.env';
const KEYS = ['NEON_AUTH_BASE_URL', 'NEON_REALTIME_URL', 'NEON_REALTIME_SECRET'];

const parse = (text) => Object.fromEntries(
  text.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => {
    const i = l.indexOf('=');
    let v = l.slice(i + 1).trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    return [l.slice(0, i), v];
  }),
);

if (!fs.existsSync(source)) {
  console.error(`${source} not found. Run "neon link" (production) or "neon env pull --branch dev --file .env.dev" first.`);
  process.exit(1);
}
const neon = parse(fs.readFileSync(source, 'utf8'));
const missing = KEYS.filter((k) => !neon[k]);
if (missing.length) {
  console.error(`${source} is missing ${missing.join(', ')}. Are Auth and Realtime enabled? (neon status)`);
  process.exit(1);
}
const vars = fs.existsSync('.dev.vars') ? parse(fs.readFileSync('.dev.vars', 'utf8')) : {};
for (const k of KEYS) vars[k] = neon[k];
vars.NEON_AUTH_COOKIE_SECRET ||= crypto.randomBytes(32).toString('base64');
fs.writeFileSync('.dev.vars', `${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });
console.log(`.dev.vars now has: ${Object.keys(vars).join(', ')} (Neon values from ${source}).`);
