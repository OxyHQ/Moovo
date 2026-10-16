/**
 * An operator script must name the database it is about to change, and that
 * name must be the one `DATABASE_URL` points at — the guard
 * `backfill-company-organizations.ts` uses, so a shell left pointing at the
 * wrong environment refuses instead of writing there.
 */
export function requireTargetDatabase(target: string | undefined): void {
  const url = process.env.DATABASE_URL;
  if (!url || !target) {
    throw new Error('Set DATABASE_URL and pass --target-database=<its database name>');
  }
  const actual = decodeURIComponent(new URL(url).pathname.slice(1));
  if (actual !== target) {
    throw new Error(`DATABASE_URL names "${actual}", not --target-database=${target}`);
  }
}
