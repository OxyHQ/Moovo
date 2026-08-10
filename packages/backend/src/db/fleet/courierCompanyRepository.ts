/**
 * Every statement this service issues against `courier_companies` and its two
 * child tables.
 *
 * `members` and `serviceAreas` were EMBEDDED ARRAYS on the company document and
 * are child tables here — which changes the write semantics in a way that is
 * easy to port wrongly and silent when wrong:
 *
 *  - **`$push`/`$pull` on an array were atomic against the parent document.**
 *    A member add is now an INSERT into another table, so anything that must
 *    happen with it (creating a company AND seeding its owner member) has to
 *    share a transaction, or a failed second statement leaves a company nobody
 *    can administer. `insertCompanyWithOwner` is that transaction.
 *  - **The source's uniqueness was positional, i.e. absent.** Nothing stopped
 *    two array entries for one `oxyUserId`; `company_members_company_oxy_user_key`
 *    now forbids it, so a duplicate add is a `23505` rather than a second entry
 *    that shadows the first. `upsertCompanyMember` converges on ONE row instead,
 *    which is what every caller actually wanted.
 *
 * A company is read WITH its members and areas almost everywhere, so the reads
 * here return the assembled record rather than making four call sites each
 * remember to fetch the children.
 */

import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type {
  CompanyPermission,
  CompanyRole,
  TextTone,
} from '@moovo/shared-types';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { companyMembers, companyServiceAreas, courierCompanies } from '../schema/fleet';

export type CourierCompanyRow = typeof courierCompanies.$inferSelect;
export type CompanyMemberRow = typeof companyMembers.$inferSelect;
export type CompanyServiceAreaRow = typeof companyServiceAreas.$inferSelect;

/** One member of a company, as its consumers read it. */
export interface CompanyMemberValue {
  oxyUserId: string;
  /**
   * Narrowed to the union the CHECK already enforces. `company_members_role_check`
   * and `_permissions_check` are rendered from the same `as const` tuples that
   * define these types, so a value outside them cannot be stored — drizzle just
   * types a `text` column as `string` and cannot know it.
   */
  role: CompanyRole;
  permissions: CompanyPermission[];
  joinedBy?: string;
  joinedAt: Date;
}

/** The company statuses `courier_companies_status_check` admits. */
export type CompanyStatus = 'active' | 'suspended' | 'closed';
/** The payout providers `courier_companies_payout_provider_check` admits. */
export type CompanyPayoutProvider = 'oxy_pay';

/** A circle the company serves. */
export interface CompanyServiceAreaValue {
  center: { type: 'Point'; coordinates: number[] };
  radiusM: number;
}

/** A company plus its children — the shape the services and DTOs consume. */
export interface CourierCompanyRecord {
  id: string;
  handle: string;
  name: string;
  description: string;
  logoFileId?: string;
  coverFileId?: string;
  brandColor: string;
  textTone: TextTone;
  status: CompanyStatus;
  members: CompanyMemberValue[];
  serviceAreas: CompanyServiceAreaValue[];
  defaultCurrency: string;
  rating: number;
  reviewCount: number;
  completedJobs: number;
  payout: { provider: CompanyPayoutProvider; accountRef?: string };
  createdAt: Date;
  updatedAt: Date;
}

function toMemberValue(row: CompanyMemberRow): CompanyMemberValue {
  const value: CompanyMemberValue = {
    oxyUserId: row.oxyUserId,
    role: row.role as CompanyRole,
    permissions: row.permissions as CompanyPermission[],
    joinedAt: row.joinedAt,
  };
  if (row.joinedBy !== null) value.joinedBy = row.joinedBy;
  return value;
}

/**
 * A service area, skipping any row whose centre was never set.
 *
 * `company_service_areas_center_shape_check` makes the pair both-or-neither, so
 * a half-set centre is unrepresentable — but a row with NO centre at all is
 * legal (the source never marked either sub-field required). Such a row has no
 * `center` to report, and inventing `[0, 0]` would place it off the coast of
 * Africa, so it is omitted rather than defaulted.
 */
function toServiceAreaValue(row: CompanyServiceAreaRow): CompanyServiceAreaValue | null {
  if (row.longitude === null || row.latitude === null) return null;
  return {
    center: { type: 'Point', coordinates: [row.longitude, row.latitude] },
    radiusM: row.radiusM,
  };
}

function toCompanyRecord(
  row: CourierCompanyRow,
  members: CompanyMemberRow[],
  areas: CompanyServiceAreaRow[],
): CourierCompanyRecord {
  const record: CourierCompanyRecord = {
    id: row.id,
    handle: row.handle,
    name: row.name,
    description: row.description,
    brandColor: row.brandColor,
    textTone: row.textTone as TextTone,
    status: row.status as CompanyStatus,
    members: members.map(toMemberValue),
    serviceAreas: areas
      .map(toServiceAreaValue)
      .filter((area): area is CompanyServiceAreaValue => area !== null),
    defaultCurrency: row.defaultCurrency,
    rating: row.rating,
    reviewCount: row.reviewCount,
    completedJobs: row.completedJobs,
    payout: { provider: row.payoutProvider as CompanyPayoutProvider },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.logoFileId !== null) record.logoFileId = row.logoFileId;
  if (row.coverFileId !== null) record.coverFileId = row.coverFileId;
  if (row.payoutAccountRef !== null) record.payout.accountRef = row.payoutAccountRef;
  return record;
}

/** Load the children for a set of companies in TWO statements, never N+1. */
async function loadChildren(
  companyIds: readonly string[],
  db: DatabaseOrTransaction,
): Promise<{
  membersByCompany: Map<string, CompanyMemberRow[]>;
  areasByCompany: Map<string, CompanyServiceAreaRow[]>;
}> {
  const membersByCompany = new Map<string, CompanyMemberRow[]>();
  const areasByCompany = new Map<string, CompanyServiceAreaRow[]>();
  if (companyIds.length === 0) return { membersByCompany, areasByCompany };

  const ids = [...companyIds];
  const [memberRows, areaRows] = await Promise.all([
    db
      .select()
      .from(companyMembers)
      .where(inArray(companyMembers.companyId, ids))
      .orderBy(asc(companyMembers.joinedAt), asc(companyMembers.id)),
    db
      .select()
      .from(companyServiceAreas)
      .where(inArray(companyServiceAreas.companyId, ids))
      .orderBy(asc(companyServiceAreas.createdAt), asc(companyServiceAreas.id)),
  ]);

  for (const row of memberRows) {
    const list = membersByCompany.get(row.companyId);
    if (list) list.push(row);
    else membersByCompany.set(row.companyId, [row]);
  }
  for (const row of areaRows) {
    const list = areasByCompany.get(row.companyId);
    if (list) list.push(row);
    else areasByCompany.set(row.companyId, [row]);
  }
  return { membersByCompany, areasByCompany };
}

/** Whether a handle is taken — the port of `CourierCompany.exists({handle})`. */
export async function companyHandleExists(
  handle: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: courierCompanies.id })
    .from(courierCompanies)
    .where(eq(courierCompanies.handle, handle))
    .limit(1);
  return row !== undefined;
}

/** One company with its children, or null. */
export async function findCompanyById(
  companyId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CourierCompanyRecord | null> {
  const [row] = await db
    .select()
    .from(courierCompanies)
    .where(eq(courierCompanies.id, companyId))
    .limit(1);
  if (!row) return null;
  const { membersByCompany, areasByCompany } = await loadChildren([row.id], db);
  return toCompanyRecord(row, membersByCompany.get(row.id) ?? [], areasByCompany.get(row.id) ?? []);
}

/** Companies a person is a member of, newest first. */
export async function listCompaniesForMember(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CourierCompanyRecord[]> {
  const rows = await db
    .select({ company: courierCompanies })
    .from(courierCompanies)
    .innerJoin(companyMembers, eq(companyMembers.companyId, courierCompanies.id))
    .where(eq(companyMembers.oxyUserId, oxyUserId))
    .orderBy(desc(courierCompanies.createdAt), desc(courierCompanies.id));

  const companies = rows.map((r) => r.company);
  const { membersByCompany, areasByCompany } = await loadChildren(
    companies.map((c) => c.id),
    db,
  );
  return companies.map((c) =>
    toCompanyRecord(c, membersByCompany.get(c.id) ?? [], areasByCompany.get(c.id) ?? []),
  );
}

/** What creating a company needs. */
export interface NewCourierCompany {
  handle: string;
  name: string;
  description: string;
  brandColor: string;
  textTone?: string | undefined;
  logoFileId?: string | undefined;
  coverFileId?: string | undefined;
  defaultCurrency?: string | undefined;
}

/**
 * Create a company and seed its owner member, in ONE transaction.
 *
 * The source pushed the owner into the embedded `members` array as part of the
 * same document insert, so the two facts were atomic for free. They are two
 * statements now, and a company with no owner is a company nobody can
 * administer and no endpoint can repair — so they commit together or not at all.
 */
export async function insertCompanyWithOwner(
  input: NewCourierCompany,
  owner: { oxyUserId: string; permissions: CompanyPermission[] },
  db: DatabaseOrTransaction = getDb(),
): Promise<CourierCompanyRecord> {
  const run = async (tx: DatabaseOrTransaction): Promise<CourierCompanyRecord> => {
    const [company] = await tx
      .insert(courierCompanies)
      .values({
        id: uuidv7(),
        handle: input.handle,
        name: input.name,
        description: input.description,
        brandColor: input.brandColor,
        ...(input.textTone === undefined ? {} : { textTone: input.textTone }),
        logoFileId: input.logoFileId ?? null,
        coverFileId: input.coverFileId ?? null,
        ...(input.defaultCurrency === undefined
          ? {}
          : { defaultCurrency: input.defaultCurrency }),
      })
      .returning();
    if (!company) throw new Error('Inserting a courier company returned no row');

    await tx.insert(companyMembers).values({
      id: uuidv7(),
      companyId: company.id,
      oxyUserId: owner.oxyUserId,
      role: 'owner',
      permissions: owner.permissions,
      joinedAt: new Date(),
    });

    const { membersByCompany, areasByCompany } = await loadChildren([company.id], tx);
    return toCompanyRecord(
      company,
      membersByCompany.get(company.id) ?? [],
      areasByCompany.get(company.id) ?? [],
    );
  };

  // Join the caller's transaction when there is one; open our own otherwise.
  return 'transaction' in db && typeof db.transaction === 'function'
    ? await (db as ReturnType<typeof getDb>).transaction(run)
    : await run(db);
}

/** The mutable fields of a company. */
export interface CourierCompanyPatch {
  name?: string | undefined;
  description?: string | undefined;
  brandColor?: string | undefined;
  textTone?: string | undefined;
  logoFileId?: string | undefined;
  coverFileId?: string | undefined;
  status?: string | undefined;
  defaultCurrency?: string | undefined;
  payoutAccountRef?: string | undefined;
}

export async function updateCompany(
  companyId: string,
  patch: CourierCompanyPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<CourierCompanyRecord | null> {
  const set: Partial<typeof courierCompanies.$inferInsert> = {};
  for (const key of [
    'name',
    'description',
    'brandColor',
    'textTone',
    'logoFileId',
    'coverFileId',
    'status',
    'defaultCurrency',
    'payoutAccountRef',
  ] as const) {
    const value = patch[key];
    if (value !== undefined) set[key] = value;
  }
  if (Object.keys(set).length > 0) {
    await db.update(courierCompanies).set(set).where(eq(courierCompanies.id, companyId));
  }
  return findCompanyById(companyId, db);
}

/** Replace the company's service areas wholesale — the source `$set` the array. */
export async function replaceCompanyServiceAreas(
  companyId: string,
  areas: readonly CompanyServiceAreaValue[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const run = async (tx: DatabaseOrTransaction): Promise<void> => {
    await tx.delete(companyServiceAreas).where(eq(companyServiceAreas.companyId, companyId));
    if (areas.length === 0) return;
    await tx.insert(companyServiceAreas).values(
      areas.map((area) => ({
        id: uuidv7(),
        companyId,
        longitude: area.center.coordinates[0] ?? null,
        latitude: area.center.coordinates[1] ?? null,
        radiusM: area.radiusM,
      })),
    );
  };
  // Delete-then-insert must be atomic: a failure between them would leave the
  // company with NO service areas, which reads as "serves nowhere".
  return 'transaction' in db && typeof db.transaction === 'function'
    ? await (db as ReturnType<typeof getDb>).transaction(run)
    : await run(db);
}

/** One member of one company, or null. */
export async function findCompanyMember(
  companyId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CompanyMemberValue | null> {
  const [row] = await db
    .select()
    .from(companyMembers)
    .where(
      and(eq(companyMembers.companyId, companyId), eq(companyMembers.oxyUserId, oxyUserId)),
    )
    .limit(1);
  return row ? toMemberValue(row) : null;
}

/**
 * Add or update a member, converging on ONE row.
 *
 * `ON CONFLICT DO UPDATE` rather than an insert that can fail: the source
 * pushed into an array with no uniqueness, so adding an existing member
 * produced a second entry that shadowed the first depending on which the reader
 * hit. The unique index makes that unrepresentable, and converging is what the
 * callers meant — "this person is a dispatcher now".
 *
 * `joinedAt`/`joinedBy` are set only on INSERT: re-adding somebody must not
 * rewrite when they originally joined.
 */
export async function upsertCompanyMember(
  companyId: string,
  member: {
    oxyUserId: string;
    role: CompanyRole;
    permissions: CompanyPermission[];
    joinedBy?: string | undefined;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<CompanyMemberValue> {
  const [row] = await db
    .insert(companyMembers)
    .values({
      id: uuidv7(),
      companyId,
      oxyUserId: member.oxyUserId,
      role: member.role,
      permissions: member.permissions,
      joinedBy: member.joinedBy ?? null,
      joinedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [companyMembers.companyId, companyMembers.oxyUserId],
      set: { role: member.role, permissions: member.permissions },
    })
    .returning();
  if (!row) throw new Error('Upserting a company member returned no row');
  return toMemberValue(row);
}

/** Remove a member, answering whether there was one to remove. */
export async function deleteCompanyMember(
  companyId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const result = await db
    .delete(companyMembers)
    .where(
      and(eq(companyMembers.companyId, companyId), eq(companyMembers.oxyUserId, oxyUserId)),
    );
  return (result.count ?? 0) > 0;
}
