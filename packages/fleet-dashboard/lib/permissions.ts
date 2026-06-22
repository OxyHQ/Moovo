import type {
  Company,
  CompanyMember,
  CompanyPermission,
  CompanyRole,
} from "@moovo/shared-types";

/**
 * Company permission model — a faithful client mirror of the backend's
 * `effectiveCompanyPermissions` (see `middleware/company-authz.ts`) so the UI
 * gates actions on the SAME effective permission set the API enforces. This is
 * UI affordance only; the API remains the source of truth and re-checks every
 * write (a hidden button is not a security control).
 */

const ALL_PERMISSIONS: readonly CompanyPermission[] = [
  "company:manage",
  "members:manage",
  "fleet:write",
  "jobs:read",
  "jobs:dispatch",
  "stats:read",
];

/** Default permission set granted by each role (mirrors `ROLE_PERMISSIONS`). */
const ROLE_PERMISSIONS: Record<CompanyRole, readonly CompanyPermission[]> = {
  owner: ALL_PERMISSIONS,
  dispatcher: ALL_PERMISSIONS.filter((p) => p !== "company:manage"),
  driver: ["jobs:read"],
};

/** A member's effective permissions: role defaults ∪ explicit grants. */
export function effectivePermissions(
  member: CompanyMember,
): Set<CompanyPermission> {
  const effective = new Set<CompanyPermission>(ROLE_PERMISSIONS[member.role]);
  for (const perm of member.permissions) {
    effective.add(perm);
  }
  return effective;
}

/** Whether `member` holds `perm` (role defaults ∪ explicit grants). */
export function hasPermission(
  member: CompanyMember | undefined,
  perm: CompanyPermission,
): boolean {
  if (!member) return false;
  return effectivePermissions(member).has(perm);
}

/** Find the caller's membership in a company, by Oxy user id. */
export function findMembership(
  company: Company | undefined,
  oxyUserId: string | undefined,
): CompanyMember | undefined {
  if (!company || !oxyUserId) return undefined;
  return company.members.find((m) => m.oxyUserId === oxyUserId);
}

/** Number of owners in a company (used to enforce the last-owner rule in the UI). */
export function ownerCount(company: Company): number {
  return company.members.filter((m) => m.role === "owner").length;
}
