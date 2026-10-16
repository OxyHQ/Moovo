/**
 * Reconcile Moovo's file references with Oxy by hand (oxy ADR 0043 D6) — the
 * same operation the dispatcher runs nightly.
 *
 *   bun dist/scripts/reconcile-file-references.js --target-database=moovo                  # dry run, every type
 *   bun dist/scripts/reconcile-file-references.js --target-database=moovo --entity-type=listing --apply
 *
 * A DRY RUN by default: Oxy reports what it would add and remove and changes
 * nothing. Needs `files:references:write`. See `docs/oxy-files.md`.
 */
import { parseArgs } from 'node:util';
import { FILE_REFERENCE_ENTITY_TYPES } from '../db/schema/valueSets.js';
import {
  isFileReferenceEntityType,
  type FileReferenceEntityType,
} from '../db/files/fileReferenceRepository.js';
import { reconcileFileReferences } from '../services/files/file-references.service.js';
import { requireTargetDatabase } from './script-target.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'target-database': { type: 'string' },
      'entity-type': { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  requireTargetDatabase(values['target-database']);
  const requested = values['entity-type'];
  if (requested !== undefined && !isFileReferenceEntityType(requested)) {
    throw new Error(
      `--entity-type must be one of: ${FILE_REFERENCE_ENTITY_TYPES.join(', ')} (got "${requested}")`,
    );
  }
  const types: readonly FileReferenceEntityType[] =
    requested === undefined ? FILE_REFERENCE_ENTITY_TYPES : [requested as FileReferenceEntityType];
  const dryRun = values.apply !== true;
  for (const entityType of types) {
    const result = await reconcileFileReferences(entityType, { dryRun });
    console.log(JSON.stringify(result));
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
