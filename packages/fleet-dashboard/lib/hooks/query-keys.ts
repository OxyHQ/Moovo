import type { JobStatus } from "@moovo/shared-types";

/**
 * Centralized TanStack Query cache keys for the Moovo Hub fleet dashboard.
 *
 * Company-scoped resources nest under the company id so a single
 * `invalidateQueries({ queryKey: queryKeys.companies.detail(id) })` (or a
 * coarser prefix) reliably refetches everything tied to that company.
 */
export const queryKeys = {
  notifications: {
    all: ["notifications"] as const,
  },
  companies: {
    all: ["companies"] as const,
    detail: (companyId: string) => ["companies", companyId] as const,
    members: (companyId: string) => ["companies", companyId, "members"] as const,
    vehicles: (companyId: string) =>
      ["companies", companyId, "vehicles"] as const,
  },
  jobs: {
    all: ["jobs"] as const,
    /** The operator's jobs as a sender or assigned courier (role-scoped). */
    list: (role: "sender" | "courier", status?: JobStatus) =>
      ["jobs", "list", role, status ?? "all"] as const,
  },
} as const;
