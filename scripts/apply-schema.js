// Creates any missing tables (safe to run repeatedly). Seeding does this too.
//   DATABASE_URL=<Neon direct connection string> npm run db:schema
import { connect, setDefaultDb } from '../src/db.js';
import { applySchema } from './seed.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to your Neon direct connection string.');
  process.exit(1);
}
const sql = connect(url, { max: 1, prepare: false });
setDefaultDb(sql);
try {
  await applySchema();
  console.log('Schema is up to date.');
} finally {
  await sql.end();
}
