export const AIRLINE = {
  name: 'Adinkra Airways',
  code: 'AD',
  ticketPrefix: '839',
  currency: 'GHS',
  hub: 'ACC',
};

// Worker bindings arrive per request (env); Node scripts and tests use process.env.
let workerEnv = null;
export function setEnv(env) {
  workerEnv = env;
}
export function envVar(name) {
  return workerEnv?.[name] ?? globalThis.process?.env?.[name];
}

let cachedKeys = null;
/** DATA_KEY (AES-256-GCM) and HMAC_KEY (signing): 64 hex chars each, set as Worker secrets. */
export function keys() {
  if (cachedKeys) return cachedKeys;
  const dataKey = envVar('DATA_KEY');
  const hmacKey = envVar('HMAC_KEY');
  const hex64 = /^[0-9a-f]{64}$/i;
  if (!hex64.test(dataKey || '') || !hex64.test(hmacKey || '')) {
    throw new Error('DATA_KEY and HMAC_KEY must be set to 64 hex characters (run "npm run secrets:generate")');
  }
  cachedKeys = { dataKey, hmacKey };
  return cachedKeys;
}
