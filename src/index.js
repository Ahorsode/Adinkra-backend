// Cloudflare Worker entry point.
import { createApp } from './app.js';
import { connect, withDb } from './db.js';
import { setEnv } from './config.js';
import { expireHolds } from './services.js';

const app = createApp();

/** Opens a Postgres connection through Hyperdrive for one request / cron run. */
function openDb(env) {
  const url = env.HYPERDRIVE?.connectionString || env.DATABASE_URL;
  if (!url) throw new Error('No database configured: add the HYPERDRIVE binding (or DATABASE_URL for local dev)');
  return connect(url, { max: Number(env.DB_MAX_CONNECTIONS) || 5 });
}

export default {
  async fetch(request, env, ctx) {
    setEnv(env);
    const sql = openDb(env);
    try {
      return await withDb(sql, () => app.fetch(request, env, ctx));
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }));
    }
  },

  // Cron trigger (wrangler.jsonc): releases seats from unpaid bookings whose hold has expired.
  async scheduled(_controller, env, ctx) {
    setEnv(env);
    const sql = openDb(env);
    ctx.waitUntil(withDb(sql, () => expireHolds()).finally(() => sql.end({ timeout: 5 })));
  },
};
