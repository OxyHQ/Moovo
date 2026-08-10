/**
 * A courier service must not reach a marketplace model to resolve a file id.
 *
 * `resolveMedia` used to live in `catalog-hydration.service.ts`, which imports
 * the `ProductVariant`, `SellerProfile` and `Store` Mongoose models at module
 * scope. Three courier services call it, so a courier profile's avatar and a
 * delivery's proof-of-delivery photo each dragged in three marketplace models.
 *
 * Nothing else would notice that coming back: it type-checks, every suite stays
 * green, and the cost is invisible until the marketplace models change or go
 * away. So the boundary is asserted over the real module graph — TRANSITIVELY,
 * because the whole point is that the offending edge was one hop further out
 * than the import line in the courier file.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const SERVICES = path.join(__dirname, '..');

const COURIER_ENTRY_POINTS = [
  'courier-hydration.service.ts',
  'job-hydration.service.ts',
  'shipment-hydration.service.ts',
];

/** Resolve a relative specifier as written (`./x.js` -> `x.ts`) to a real file. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates: string[] = [];
  if (base.endsWith('.js')) {
    const stem = base.slice(0, -3);
    candidates.push(`${stem}.ts`, path.join(stem, 'index.ts'));
  }
  candidates.push(base, `${base}.ts`, path.join(base, 'index.ts'));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Every module reachable from `entry`, plus the edge that led to each.
 *
 * Type-only imports are included deliberately: a `import type { IStore }` still
 * couples the courier half to a marketplace model's shape, and it is what
 * breaks the build the day that model is deleted.
 */
function reachableFrom(entry: string): Map<string, string> {
  const via = new Map<string, string>();
  const stack = [entry];
  const seen = new Set<string>();
  const SPECIFIER = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;

  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const source = readFileSync(current, 'utf8');
    SPECIFIER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SPECIFIER.exec(source)) !== null) {
      const target = resolveSpecifier(current, match[1]);
      if (target === null || seen.has(target)) continue;
      if (!via.has(target)) via.set(target, current);
      stack.push(target);
    }
  }
  return via;
}

const MODELS_DIR = path.join(SERVICES, '..', 'models') + path.sep;

describe('courier hydration is independent of the marketplace models', () => {
  it.each(COURIER_ENTRY_POINTS)('%s reaches no model in src/models/', (entryName) => {
    const entry = path.join(SERVICES, entryName);
    expect(existsSync(entry)).toBe(true);

    const reachable = reachableFrom(entry);

    // Vacuity floor. An empty graph passes every assertion below, and a broken
    // resolver produces exactly that — which is the shape this whole file is
    // guarding against elsewhere.
    expect(reachable.size).toBeGreaterThan(5);

    const offenders = [...reachable.entries()]
      .filter(([file]) => file.startsWith(MODELS_DIR))
      // Name the importer, not just the model: the edge that matters is one hop
      // out, and "something reaches Store" is not an actionable failure.
      .map(([file, importer]) => `${path.relative(SERVICES, importer)} -> ${path.relative(SERVICES, file)}`);

    expect(offenders).toEqual([]);
  });

  it('resolves media through media.service, not catalog-hydration', () => {
    for (const entryName of COURIER_ENTRY_POINTS) {
      const source = readFileSync(path.join(SERVICES, entryName), 'utf8');
      expect(source).toContain("from './media.service.js'");
      expect(source).not.toContain("resolveMedia } from './catalog-hydration.service.js'");
    }
  });

  /**
   * The control names a file that STILL reaches `src/models/`, and that file
   * changes as the port advances.
   *
   * It was `catalog-hydration.service.ts` until the catalogue moved to
   * PostgreSQL, at which point this case went red — correctly. It was measuring
   * "the traversal can resolve into `src/models/`" using a file that had
   * stopped reaching models at all, so the assertions above would have gone on
   * passing for a reason that had nothing to do with the boundary.
   *
   * It briefly named `cart.service.ts` and went red again one slice later, so
   * it now names **`scripts/seed.ts`, which imports five models and is retired
   * in the FINAL slice** — the last file in the tree to stop reaching models.
   * That stops the control chasing the port from slice to slice.
   *
   * Naming the file explicitly rather than searching for any importer is
   * deliberate: an explicit name fails loudly, which forces a decision, where a
   * search would silently keep finding something until the last model went and
   * then fail with no clue why.
   *
   * **When `src/models/` is deleted, DELETE THIS WHOLE FILE.** The boundary it
   * guards is then enforced by the models not existing, and a control that
   * cannot be satisfied is not a gate — it is a permanent red.
   */
  it('proves the traversal can see a model at all (positive control)', () => {
    // Without this, the passing cases above are indistinguishable from a
    // traversal that never resolves anything into src/models/.
    const reachable = reachableFrom(path.join(SERVICES, '..', 'scripts', 'seed.ts'));
    const models = [...reachable.keys()].filter((file) => file.startsWith(MODELS_DIR));
    expect(models.length).toBeGreaterThan(0);
  });
});
