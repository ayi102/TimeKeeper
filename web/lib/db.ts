import postgres from "postgres";

/**
 * Lazy Postgres singleton (Supabase). Created on first use so a missing
 * DATABASE_URL doesn't blow up at import/build time. Use the Supabase *pooled*
 * connection string (port 6543) on serverless; prepared statements are disabled
 * because the pooler runs in transaction mode.
 */
let client: ReturnType<typeof postgres> | null = null;

export function sql() {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    client = postgres(url, { prepare: false });
  }
  return client;
}
