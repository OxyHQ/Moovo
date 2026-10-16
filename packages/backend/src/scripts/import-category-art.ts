/**
 * Import every category's hotlinked art into Oxy as a file the Moovo
 * application owns (oxy ADR 0043 D7), and point the category at it.
 *
 *   bun dist/scripts/import-category-art.js --target-database=moovo           # preview
 *   bun dist/scripts/import-category-art.js --target-database=moovo --apply   # import
 *
 * A PREVIEW by default: it lists the categories (by slug and source host, never
 * the URL) and changes nothing. Idempotent: a category that has art is never
 * selected, and Oxy answers a repeat import of the same URL with the file it
 * already holds. Needs the Moovo service identity with `files:app:write` and
 * `files:references:write`. See `docs/oxy-files.md`.
 */
import { parseArgs } from 'node:util';
import { importCategoryArt } from '../services/files/category-art.service.js';
import { requireTargetDatabase } from './script-target.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'target-database': { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  requireTargetDatabase(values['target-database']);
  const report = await importCategoryArt({ apply: values.apply === true });
  console.log(JSON.stringify(report, null, 2));
  if (report.failed.length > 0 || report.invalid.length > 0) process.exitCode = 2;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
