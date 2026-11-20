// Postgres access for the Worker (via Hyperdrive) and for Node scripts/tests.
//
// Queries keep the original "?" placeholders; they are rewritten to $1, $2… here.
// Each request gets its own connection (Workers can't share sockets between
// requests); transactions are tracked with AsyncLocalStorage so helpers called
// inside tx() automatically run on the transaction's connection.
import postgres from 'postgres';
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
let fallbackSql = null;

/** bigint (COUNT, SUM of ints) and numeric come back as strings by default; the app expects numbers. */
const NUMBER_TYPES = {
  bigint: { to: 20, from: [20, 1700], serialize: (x) => String(x), parse: (x) => Number(x) },
};

export function connect(url, opts = {}) {
  return postgres(url, { max: 5, fetch_types: false, prepare: true, types: NUMBER_TYPES, onnotice: () => {}, ...opts });
}

/** Runs fn with `sql` as the connection for every helper call made inside it. */
export const withDb = (sql, fn) => als.run({ sql, inTx: false }, fn);
/** For Node scripts/tests: a connection used when no request context is active. */
export const setDefaultDb = (sql) => {
  fallbackSql = sql;
};

function current() {
  const store = als.getStore();
  const sql = store?.sql || fallbackSql;
  if (!sql) throw new Error('No database connection for this request');
  return { sql, store };
}

/** Converts ? placeholders to $n, skipping quoted strings. */
const converted = new Map();
function pg(text) {
  let out = converted.get(text);
  if (out) return out;
  let n = 0;
  let quote = null;
  out = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === '?') out += `$${++n}`;
    else out += ch;
  }
  converted.set(text, out);
  return out;
}
const norm = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

const exec = (text, params) => current().sql.unsafe(pg(text), norm(params));

export const all = async (text, ...p) => [...(await exec(text, p))];
export const one = async (text, ...p) => (await exec(text, p))[0];
export const run = async (text, ...p) => ({ changes: (await exec(text, p)).count });
/** INSERT … and return the new row's id. */
export const insert = async (text, ...p) => (await exec(`${text} RETURNING id`, p))[0]?.id;

/**
 * Inserts many rows in as few statements as possible.
 * rows: array of arrays in `cols` order. Returns the ids when `returning` is set.
 */
export async function insertMany(table, cols, rows, { onConflict = '', returning = false, chunk } = {}) {
  const ids = [];
  const size = chunk || Math.max(1, Math.floor(30000 / cols.length));
  for (let i = 0; i < rows.length; i += size) {
    const part = rows.slice(i, i + size);
    let n = 0;
    const values = part.map((r) => `(${r.map(() => `$${++n}`).join(',')})`).join(',');
    const text = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${values} ${onConflict}${returning ? ' RETURNING id' : ''}`;
    const res = await current().sql.unsafe(text, norm(part.flat()));
    if (returning) ids.push(...res.map((r) => r.id));
  }
  return ids;
}

/** Runs fn inside a transaction (nested calls join the outer one). */
export async function tx(fn) {
  const { sql, store } = current();
  if (store?.inTx) return fn();
  return sql.begin((t) => als.run({ sql: t, inTx: true }, fn));
}

export const nowIso = () => new Date().toISOString();

const SETTING_DEFAULTS = {
  session_timeout_hours: '8',
  password_min_length: '8',
  booking_hold_minutes: '20',
  mask_pii_for_staff: '1',
  data_retention_days: '365',
  max_login_attempts: '5',
};
export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS);

export async function setting(key) {
  const row = await one('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : SETTING_DEFAULTS[key];
}
export const settingNum = async (key) => Number(await setting(key));
export async function allSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const r of await all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}
