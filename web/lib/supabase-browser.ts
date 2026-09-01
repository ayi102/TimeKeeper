import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase client for the browser. Uses @supabase/ssr so the session is stored in
 * cookies (not localStorage) — that's what lets the server middleware see the
 * logged-in state and gate pages/APIs.
 */
export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
