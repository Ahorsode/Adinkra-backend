// Neon Auth (Managed Better Auth) for the Hono Worker, built on Neon's framework-agnostic
// server toolkit (@neon/auth/server) — the same pieces Neon's Next.js adapter uses.
//
// The browser only ever talks to this API on the site's own domain (Vercel proxies /api/*),
// and the API talks to Neon Auth server-to-server. Neon's session cookies are therefore set
// first-party on the site's domain, which Safari and Chrome accept.
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createAuthServer,
  extractNeonAuthCookies,
  serializeSetCookie,
  NEON_AUTH_COOKIE_PREFIX,
  NEON_AUTH_SESSION_COOKIE_NAME,
  NEON_AUTH_SESSION_DATA_COOKIE_NAME,
  NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME,
  NEON_AUTH_NETWORK_ERROR_CODES,
} from '@neon/auth/server';
import { envVar } from './config.js';
import { HttpError } from './security.js';

const store = new AsyncLocalStorage();

/** Binds the current Hono context so Neon Auth calls read this request's cookies and set cookies on its response. */
export const withAuthContext = (c, fn) => store.run({ c }, fn);

function requestContext() {
  const c = store.getStore()?.c;
  if (!c) throw new Error('Neon Auth used outside a request');
  return {
    getCookies: () => extractNeonAuthCookies(c.req.header('cookie') ?? ''),
    setCookie: (name, value, options) => {
      c.header('Set-Cookie', serializeSetCookie({ name, value, ...options }), { append: true });
    },
    getHeader: (name) => c.req.header(name) ?? null,
    getOrigin: () => c.req.header('origin') ?? '',
    getFramework: () => 'hono',
  };
}

function config() {
  const baseUrl = envVar('NEON_AUTH_BASE_URL');
  const cookieSecret = envVar('NEON_AUTH_COOKIE_SECRET');
  if (!baseUrl || !cookieSecret) {
    throw new Error('NEON_AUTH_BASE_URL and NEON_AUTH_COOKIE_SECRET must be set (see README: Neon Auth)');
  }
  return { baseUrl, cookieSecret };
}

let cached = null;
/** Neon Auth server methods bound to the current request (signIn.email, signUp.email, getSession, …). */
export function neonAuth() {
  const { baseUrl, cookieSecret } = config();
  if (!cached || cached.key !== baseUrl + cookieSecret) {
    cached = { key: baseUrl + cookieSecret, server: createAuthServer({ baseUrl, cookieSecret, context: requestContext }) };
  }
  return cached.server;
}

/**
 * Neon Auth methods that never touch the caller's cookies: used when an admin creates a staff
 * account, so the admin stays signed in as themselves. `origin` must be a trusted domain.
 */
export function detachedNeonAuth(origin) {
  const { baseUrl, cookieSecret } = config();
  return createAuthServer({
    baseUrl,
    cookieSecret,
    context: () => ({
      getCookies: () => ({}),
      setCookie: () => {},
      getHeader: (name) => (name.toLowerCase() === 'origin' ? origin : null),
      getOrigin: () => origin,
      getFramework: () => 'hono',
    }),
  });
}

/** True when the request carries any Neon Auth cookie (avoids a session lookup for anonymous visitors). */
export const hasAuthCookie = (cookieHeader) => String(cookieHeader || '').includes(NEON_AUTH_COOKIE_PREFIX);

/** Expires Neon Auth's cookies on this response (e.g. a deactivated account that just signed in). */
export function clearAuthCookies(c) {
  for (const name of [NEON_AUTH_SESSION_COOKIE_NAME, NEON_AUTH_SESSION_DATA_COOKIE_NAME, NEON_AUTH_SESSION_CHALLENGE_COOKIE_NAME]) {
    c.header('Set-Cookie', serializeSetCookie({ name, value: '', path: '/', maxAge: 0, httpOnly: true, secure: true, sameSite: 'lax' }), { append: true });
  }
}

/** Turns a Neon Auth error envelope into an HttpError the API returns to the browser. */
export function authFailure(error, fallback = 'Sign-in service error. Please try again.') {
  if (!error) return new HttpError(500, fallback);
  if (NEON_AUTH_NETWORK_ERROR_CODES.includes(error.code)) {
    return new HttpError(503, 'The sign-in service is temporarily unreachable. Please try again in a moment.');
  }
  if (error.status === 429) {
    console.warn('Neon Auth rate limited the request', error.code, error.message);
    return new HttpError(429, 'Too many attempts. Please wait a minute and try again.');
  }
  if (error.status === 403 && /origin/i.test(error.message || '')) {
    // The site's origin is not in Neon Auth's trusted domains (neon neon-auth domain add <origin>).
    console.error('Neon Auth rejected the origin; add it as a trusted domain', error);
    return new HttpError(500, fallback);
  }
  if (error.status >= 500 || error.code === 'INTERNAL_ERROR') {
    console.error('Neon Auth error', error);
    return new HttpError(502, fallback);
  }
  return new HttpError(error.status === 401 ? 401 : 400, error.message || fallback, { code: error.code });
}
