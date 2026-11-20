// Local Postgres for development and tests, with no install: PGlite (Postgres compiled to WASM)
// served over the normal Postgres wire protocol on 127.0.0.1:5433.
//
//   npm run db:local            # keeps running; data in .pglite/ (git-ignored)
//   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres npm run db:seed
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function startLocalDb({ port = 5433, dataDir } = {}) {
  const db = await PGlite.create(dataDir ? { dataDir } : {});
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
  await server.start();
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PGPORT) || 5433;
  const { url } = await startLocalDb({ port, dataDir: process.env.PGLITE_DIR || './.pglite' });
  console.log(`Local Postgres (PGlite) listening: ${url}`);
  console.log('Press Ctrl+C to stop.');
}
