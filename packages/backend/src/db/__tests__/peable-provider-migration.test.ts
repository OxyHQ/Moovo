import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAYMENT_PROVIDERS } from '../schema/valueSets';

const migrationPath = resolve(
  import.meta.dirname,
  '../migrations/0006_sour_warbound.sql',
);
const migration = readFileSync(migrationPath, 'utf8');

const providerColumns = [
  ['orders', 'payment_provider'],
  ['courier_companies', 'payout_provider'],
  ['courier_profiles', 'payout_provider'],
  ['jobs', 'payment_provider'],
] as const;

describe('the Peable provider identifier migration', () => {
  it('makes Peable the only active provider value', () => {
    expect(PAYMENT_PROVIDERS).toEqual(['peable']);
  });

  it('renames every persisted legacy value before narrowing its constraint', () => {
    for (const [table, column] of providerColumns) {
      const update = `UPDATE "${table}" SET "${column}" = 'peable' WHERE "${column}" = 'oxy_pay'`;
      const constraint = `CHECK ("${table}"."${column}" in ('peable'))`;

      expect(migration).toContain(update);
      expect(migration).toContain(`ALTER COLUMN "${column}" SET DEFAULT 'peable'`);
      expect(migration).toContain(constraint);
      expect(migration.indexOf(update)).toBeLessThan(migration.indexOf(constraint));
    }
  });

  it('is explicitly safe for the pre-deploy phase', () => {
    expect(migration.match(/^-- oxy:deploy-phase=pre$/gm)).toHaveLength(1);
    expect(migration.match(/^-- oxy:deploy-phase=post$/gm)).toBeNull();
  });
});
