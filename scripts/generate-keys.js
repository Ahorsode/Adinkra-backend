// Prints a fresh DATA_KEY and HMAC_KEY (64 hex chars each) and writes them to .dev.vars for `wrangler dev`.
// Use the same two values for:  npx wrangler secret put DATA_KEY / HMAC_KEY  and when running the seed script.
// Keep them safe: losing DATA_KEY makes the encrypted passport / Ghana Card fields unreadable.
import crypto from 'node:crypto';
import fs from 'node:fs';

const dataKey = crypto.randomBytes(32).toString('hex');
const hmacKey = crypto.randomBytes(32).toString('hex');
const file = '.dev.vars';
if (fs.existsSync(file)) {
  console.log(`${file} already exists – not overwriting it. New keys (unused):`);
} else {
  fs.writeFileSync(file, `DATA_KEY=${dataKey}\nHMAC_KEY=${hmacKey}\n`, { mode: 0o600 });
  console.log(`Wrote ${file} (git-ignored). Keys:`);
}
console.log(`DATA_KEY=${dataKey}\nHMAC_KEY=${hmacKey}`);
