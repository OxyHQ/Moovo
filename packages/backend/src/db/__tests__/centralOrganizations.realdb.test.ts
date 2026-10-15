import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { execFileSync } from 'node:child_process';
import { createTestDatabase, dropTestDatabase } from '@oxy.so/db/testing';
import { runMigrations } from '@oxy.so/db/migrate';
import { expect, it } from 'vitest';
import { MIGRATIONS_FOLDER } from '../migrate.js';

async function through(url: string, last: number, run: 'all' | 'pre' | 'post') {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'));
  const entries = journal.entries.slice(0, last + 1) as { tag: string }[];
  const folder = mkdtempSync(join(tmpdir(), 'moovo-org-migration-'));
  try {
    mkdirSync(join(folder, 'meta'));
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const entry of entries)
      copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await runMigrations({
      databaseUrl: url,
      migrationsFolder: folder,
      extensions: [{ name: 'postgis', reason: 'Test fleet geographies' }],
      run,
      expectedDatabase: new URL(url).pathname.slice(1),
      dryRun: false,
      logger: { info: () => undefined, debug: () => undefined },
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
it('freezes populated company identity, guards unmapped cutover and preserves fleet relationships after reviewed linking', async () => {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) throw new Error('TEST_DATABASE_URL is required');
  const url = await createTestDatabase({
    adminUrl,
    migrate: async (target) => {
      const client = postgres(target);
      try {
        await client`create extension if not exists postgis`;
      } finally {
        await client.end();
      }
      await through(target, 7, 'all');
    },
  });
  const db = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await db`insert into courier_companies(id,handle,name,description,brand_color,logo_file_id) values ('legacy','legacy-fleet','Observed carrier','Fleet delivery operations','#123456','legacy-image')`;
    await db`insert into company_members(id,company_id,oxy_user_id,role,permissions) values ('member','legacy','operator','owner',ARRAY['fleet:write'])`;
    await db`insert into vehicles(id,owner_type,company_id,type) values ('vehicle','company','legacy','van')`;
    await through(url, 9, 'pre');
    await expect(
      db`update courier_companies set name='Local renamed' where id='legacy'`,
    ).rejects.toThrow('owned by Oxy');
    await expect(
      db`insert into courier_companies(id,handle,name,description,brand_color) values ('old','old','Old writer','','#fff')`,
    ).rejects.toThrow('canonical Oxy');
    await db`insert into courier_companies(id,handle,oxy_account_id,description,brand_color) values ('new','new-fleet','oxy-new','','#fff')`;
    await expect(through(url, 9, 'post')).rejects.toThrow();
    const planDir = mkdtempSync(join(tmpdir(), 'moovo-company-plan-'));
    try {
      const script = join(MIGRATIONS_FOLDER, '../../scripts/backfill-company-organizations.ts');
      const args = [
        script,
        `--target-database=${new URL(url).pathname.slice(1)}`,
        `--plan-output=${join(planDir, 'plan.json')}`,
      ];
      execFileSync('bun', args, { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
      const plan = JSON.parse(readFileSync(join(planDir, 'plan.json'), 'utf8'));
      expect(plan.records).toEqual([
        expect.objectContaining({
          id: 'legacy',
          observed_name: 'Observed carrier',
          members: 1,
          vehicles: 1,
          oxy_account_id: null,
        }),
      ]);
      expect(() =>
        execFileSync(
          'bun',
          [
            script,
            `--target-database=${new URL(url).pathname.slice(1)}`,
            '--apply',
            '--plan-sha256=stale',
          ],
          {
            env: { ...process.env, DATABASE_URL: url },
            stdio: 'pipe',
          },
        ),
      ).toThrow();
    } finally {
      rmSync(planDir, { recursive: true, force: true });
    }

    await db`update courier_companies set oxy_account_id='reviewed-organization' where id='legacy'`;
    await through(url, 9, 'post');
    expect(
      await db`select company_id,observed_name,logo_file_id from courier_company_identity_archives`,
    ).toEqual([
      { company_id: 'legacy', observed_name: 'Observed carrier', logo_file_id: 'legacy-image' },
    ]);
    expect(await db`select company_id,oxy_user_id,role from company_members`).toEqual([
      { company_id: 'legacy', oxy_user_id: 'operator', role: 'owner' },
    ]);
    expect(await db`select company_id from vehicles`).toEqual([{ company_id: 'legacy' }]);
    expect(
      await db`select handle,oxy_account_id,description from courier_companies where id='legacy'`,
    ).toEqual([
      {
        handle: 'legacy-fleet',
        oxy_account_id: 'reviewed-organization',
        description: 'Fleet delivery operations',
      },
    ]);
    expect(
      await db`select column_name from information_schema.columns where table_name='courier_companies' and column_name in ('name','logo_file_id')`,
    ).toEqual([]);
    await expect(db`delete from courier_company_identity_archives`).rejects.toThrow('immutable');
  } finally {
    await db.end();
    await dropTestDatabase(url);
  }
}, 60000);
