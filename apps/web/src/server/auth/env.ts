/**
 * Supabase Auth connection config for this Next.js app.
 *
 * Every value here is a plain environment-variable lookup — no Supabase SDK
 * import, and no local-stack-specific URL or key hardcoded anywhere else in
 * the app. Swapping this app from the local Supabase CLI stack (this phase)
 * to a real, eventually hire.agentics.org-federated, hosted Supabase project
 * (a later phase) is a config change only: new values for these two
 * variables (plus, when it's stood up, pointing `DATABASE_URL` at that
 * project's Postgres per ADR-0004/ADR-0016). No file in `src/` needs to
 * change. See `.env.example` and the README's "Local Supabase Auth stack"
 * section.
 */
export interface SupabaseAuthEnv {
  url: string;
  anonKey: string;
}

/**
 * Reads and validates the two Supabase connection variables. Deliberately
 * called at request time (not module load time) so a missing `.env` fails
 * loudly on first use with a clear message, rather than as a silent
 * `undefined` passed into `@supabase/ssr`.
 */
export function getSupabaseAuthEnv(): SupabaseAuthEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be " +
        "set (see .env.example). For local development, run `pnpm " +
        "supabase:start` then `pnpm supabase:status` to print these values.",
    );
  }

  return { url, anonKey };
}
