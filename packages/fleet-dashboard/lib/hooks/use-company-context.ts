import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import type {
  Company,
  CompanyMember,
  CompanyPermission,
} from "@moovo/shared-types";
import { fetchCompanies, fetchCompany } from "@/lib/api/companies";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useCompanyStore } from "@/lib/stores/company-store";
import { findMembership, hasPermission } from "@/lib/permissions";

/**
 * The dashboard-wide company context.
 *
 * Loads the operator's companies, resolves the EFFECTIVE selected company
 * (the persisted selection when it still exists, otherwise the first company —
 * derived, no `useEffect`), loads that company's detail, and exposes the
 * caller's membership plus a permission checker that mirrors the backend's
 * effective-permission model. All queries gate on `canUsePrivateApi` so they
 * only fire once the Oxy private API is ready.
 */
export interface CompanyContext {
  /** Whether the Oxy session has finished cold-boot resolution. */
  isAuthResolved: boolean;
  /** Whether a signed-in operator is present. */
  isAuthenticated: boolean;
  /** Whether the private API is ready (queries enabled). */
  canUsePrivateApi: boolean;
  /** The operator's companies (empty until loaded). */
  companies: Company[];
  /** Whether the companies list is still loading. */
  isLoadingCompanies: boolean;
  /** Whether the companies list failed to load. */
  isCompaniesError: boolean;
  /** Refetch the companies list. */
  refetchCompanies: () => void;
  /** The effective selected company id, or `null` when none. */
  selectedCompanyId: string | null;
  /** Persist a new company selection. */
  selectCompany: (companyId: string) => void;
  /** The selected company's full detail (preferred over the list entry). */
  company: Company | undefined;
  /** Whether the selected company's detail is loading. */
  isLoadingCompany: boolean;
  /** The caller's membership in the selected company. */
  membership: CompanyMember | undefined;
  /** Whether the caller holds `perm` in the selected company. */
  can: (perm: CompanyPermission) => boolean;
}

export function useCompanyContext(): CompanyContext {
  const { isAuthenticated, isAuthResolved, canUsePrivateApi, user } = useOxy();
  const selectedCompanyId = useCompanyStore((s) => s.selectedCompanyId);
  const setSelectedCompanyId = useCompanyStore((s) => s.setSelectedCompanyId);

  const companiesQuery = useQuery({
    queryKey: queryKeys.companies.all,
    queryFn: fetchCompanies,
    enabled: canUsePrivateApi,
  });

  const companies = companiesQuery.data ?? [];

  // Effective selection: the persisted id when it still exists, else the first
  // company. Derived during render so the dashboard always has a valid company
  // without an effect that writes to the store on mount.
  const effectiveCompanyId = useMemo<string | null>(() => {
    if (companies.length === 0) return null;
    const stillExists =
      selectedCompanyId !== null &&
      companies.some((c) => c.id === selectedCompanyId);
    return stillExists ? selectedCompanyId : (companies[0]?.id ?? null);
  }, [companies, selectedCompanyId]);

  const companyQuery = useQuery({
    queryKey: effectiveCompanyId
      ? queryKeys.companies.detail(effectiveCompanyId)
      : ["companies", "none"],
    queryFn: () => fetchCompany(effectiveCompanyId as string),
    enabled: canUsePrivateApi && effectiveCompanyId !== null,
  });

  // Prefer the freshly-fetched detail; fall back to the list entry so the UI has
  // a company to render while the detail query is still in flight.
  const company =
    companyQuery.data ??
    companies.find((c) => c.id === effectiveCompanyId) ??
    undefined;

  const membership = useMemo(
    () => findMembership(company, user?.id),
    [company, user?.id],
  );

  const can = useMemo(
    () => (perm: CompanyPermission) => hasPermission(membership, perm),
    [membership],
  );

  return {
    isAuthResolved,
    isAuthenticated,
    canUsePrivateApi,
    companies,
    isLoadingCompanies: companiesQuery.isPending,
    isCompaniesError: companiesQuery.isError,
    refetchCompanies: () => {
      void companiesQuery.refetch();
    },
    selectedCompanyId: effectiveCompanyId,
    selectCompany: setSelectedCompanyId,
    company,
    isLoadingCompany: companyQuery.isPending && effectiveCompanyId !== null,
    membership,
    can,
  };
}
