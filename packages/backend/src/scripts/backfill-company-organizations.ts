/** Reviewed, source-bound links only. Dry-run by default; never matches company names. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { z } from 'zod';
import { OxyServices } from '@oxy.so/core';

async function main() {
  const { values } = parseArgs({
    options: {
      'target-database': { type: 'string' },
      'reviewed-mappings': { type: 'string' },
      'plan-output': { type: 'string' },
      'plan-sha256': { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  const url = process.env.DATABASE_URL;
  if (
    !url ||
    !values['target-database'] ||
    decodeURIComponent(new URL(url).pathname.slice(1)) !== values['target-database']
  )
    throw new Error('DATABASE_URL must match explicit --target-database');
  const mappings = values['reviewed-mappings']
    ? z
        .array(
          z
            .object({
              companyId: z.string().min(1),
              accountId: z.string().min(1),
              evidenceReference: z.string().trim().min(1),
            })
            .strict(),
        )
        .parse(JSON.parse(await readFile(values['reviewed-mappings'], 'utf8')))
    : [];
  const db = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const records = await db.begin('isolation level repeatable read read only', async (tx) => {
      const [database] = await tx`select current_database() as name`;
      if (database?.name !== values['target-database']) throw new Error('Unexpected database');
      return tx<
        {
          id: string;
          oxy_account_id: string | null;
          observed_name: string;
          logo_file_id: string | null;
          members: number;
          vehicles: number;
          profiles: number;
          areas: number;
          jobs: number;
          offers: number;
        }[]
      >`select c.id,c.oxy_account_id,a.observed_name,a.logo_file_id,
    (select count(*)::int from company_members m where m.company_id=c.id) as members,
    (select count(*)::int from vehicles v where v.company_id=c.id) as vehicles,
    (select count(*)::int from courier_profiles p where p.company_id=c.id) as profiles,
    (select count(*)::int from company_service_areas s where s.company_id=c.id) as areas,
    (select count(*)::int from jobs j where j.company_id=c.id) as jobs,
    (select count(*)::int from job_offers o where o.company_id=c.id) as offers
    from courier_companies c join courier_company_identity_archives a on a.company_id=c.id order by c.id`;
    });
    const plan = {
      database: values['target-database'],
      records,
      mappings: [...mappings].sort((a, b) => a.companyId.localeCompare(b.companyId)),
    };
    const sha256 = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    if (values['plan-output'])
      await writeFile(values['plan-output'], JSON.stringify({ ...plan, sha256 }, null, 2), {
        mode: 0o600,
        flag: 'wx',
      });
    console.log(
      JSON.stringify({
        mode: values.apply ? 'apply' : 'dry-run',
        database: plan.database,
        total: records.length,
        unmapped: records.filter((row) => !row.oxy_account_id).length,
        reviewed: mappings.length,
        sha256,
      }),
    );
    if (!values.apply) return;
    if (values['plan-sha256'] !== sha256) throw new Error('Plan changed; review a fresh dry-run');
    if (!process.env.OXY_ADMIN_ACCESS_TOKEN)
      throw new Error('Reviewed mapping requires an authorized Oxy staff session');
    const ids = new Set<string>();
    for (const mapping of mappings) {
      const record = records.find((row) => row.id === mapping.companyId);
      if (
        !record ||
        ids.has(mapping.companyId) ||
        (record.oxy_account_id && record.oxy_account_id !== mapping.accountId)
      )
        throw new Error('Invalid, duplicate or conflicting reviewed mapping');
      ids.add(mapping.companyId);
    }
    const oxy = new OxyServices({
      baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
      enableCache: false,
    });
    oxy.session.setAccessToken(process.env.OXY_ADMIN_ACCESS_TOKEN);
    try {
      for (const mapping of mappings) {
        const record = records.find((row) => row.id === mapping.companyId);
        if (!record) throw new Error('Missing source evidence');
        const linked = await oxy.organizations.importExternal({
          namespace: 'moovo',
          externalId: record.id,
          accountId: mapping.accountId,
          organization: { name: record.observed_name, organizationType: 'business' },
          evidenceReference: mapping.evidenceReference,
        });
        const updated =
          await db`update courier_companies set oxy_account_id=${linked.accountId} where id=${record.id} and (oxy_account_id is null or oxy_account_id=${linked.accountId}) returning id`;
        if (updated.length !== 1) throw new Error('Mapping changed; stop and review a fresh plan');
      }
    } finally {
      oxy.dispose();
    }
  } finally {
    await db.end();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Organization backfill failed');
  process.exitCode = 1;
});
