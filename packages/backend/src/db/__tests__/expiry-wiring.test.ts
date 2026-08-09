/**
 * Does anything actually CALL the expiry sweep?
 *
 * This test exists because of a specific failure in a sibling Oxy port: its
 * `db/expiry.ts` documented "its one caller in `server.ts`", that call did not
 * exist, and the test asserting the wiring only asserted the shape of the
 * target LIST. Two layers each claimed a mechanism that was absent, and the
 * tables simply grew.
 *
 * A registry is the half of expiry that looks complete while doing nothing —
 * every table listed, every retention stated, no row ever deleted. The other
 * half is a single call in the server entrypoint, and nothing about reading
 * `db/expiry.ts` reveals whether it is there.
 *
 * So this reads the ENTRYPOINT SOURCE. It needs no database, so it runs
 * everywhere the suite runs, including where Postgres is unavailable — the
 * wiring is exactly the thing that must not be conditional on the environment
 * that tests it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPIRY_TARGETS } from '../expiry';

const ENTRYPOINT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.ts');

/**
 * Source with comments removed.
 *
 * Load-bearing: the entrypoint explains at length WHY the sweeper is started,
 * naming it repeatedly. A scan over raw source would be satisfied by that
 * prose alone, so deleting the call would leave this test green — the exact
 * false green the sibling port shipped.
 */
function entrypointCode(): string {
  return readFileSync(ENTRYPOINT, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('the expiry sweep is wired into the server entrypoint', () => {
  it('reads an entrypoint that is actually there', () => {
    // Vacuity floor. A path that silently resolved to nothing would make every
    // assertion below pass against an empty string.
    const code = entrypointCode();
    expect(code.length).toBeGreaterThan(2_000);
    expect(code).toContain('server.listen');
  });

  it('imports and CALLS startExpirySweeper', () => {
    const code = entrypointCode();
    expect(code).toMatch(/import\s*\{[^}]*startExpirySweeper[^}]*\}\s*from\s*'\.\/db\/expiry\.js'/);
    // The call itself, not merely the identifier: an import with no invocation
    // is precisely the shape of the bug this file guards against.
    expect(code).toMatch(/startExpirySweeper\s*\(\s*\)/);
  });

  it('stops the sweeper on shutdown', () => {
    expect(entrypointCode()).toMatch(/stopExpirySweeper\s*\(\s*\)/);
  });

  it('would fail if the registry were emptied', () => {
    // A wired caller sweeping an empty list is the same no-op as no caller at
    // all, so the wiring assertion is only meaningful beside a non-empty
    // registry.
    expect(EXPIRY_TARGETS.length).toBeGreaterThan(0);
  });
});
