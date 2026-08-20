import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * The session cookie policy this app enforces everywhere it writes
 * Supabase's session cookies (ADR-0006's Decision: "set as `httpOnly`,
 * `secure`, `sameSite=lax`").
 *
 * `@supabase/ssr` itself defaults new cookies to `httpOnly: false` (see its
 * `DEFAULT_COOKIE_OPTIONS` — that default exists because the same cookie
 * storage code path is shared with its *browser* client, which needs to
 * read/write the cookie from client-side JS). This app never reads the
 * session cookie from client-side JavaScript — every verification happens
 * server-side (`proxy.ts`, tRPC context) — so httpOnly is both safe and
 * required here; nothing in this app relies on the browser being able to
 * read this cookie.
 *
 * `secure: true` is safe for local development too: both Chrome and
 * Firefox treat `http://localhost` (and `http://127.0.0.1`) as a
 * "potentially trustworthy" origin per the Secure Contexts spec, so
 * `Secure` cookies are still set and sent over plain HTTP on loopback
 * addresses — this does not require running the local dev server over
 * HTTPS.
 */
export const SUPABASE_COOKIE_OPTIONS: CookieOptionsWithName = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
};
