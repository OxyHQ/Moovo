import { useMemo } from "react";
import { View, ActivityIndicator } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  Star,
  MessageSquare,
  Truck,
} from "lucide-react-native";
import type { JobStatus, CompanyRole } from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Card } from "@/components/ui/card";
import { DashboardScreen } from "@/components/dashboard/DashboardScreen";
import {
  CompanyHeader,
  NoCompaniesState,
  PermissionDenied,
} from "@/components/dashboard/CompanyHeader";
import { StatCard } from "@/components/dashboard/StatCard";
import { BarRow } from "@/components/dashboard/BarRow";
import { fetchJobs } from "@/lib/api/jobs";
import { fetchVehicles } from "@/lib/api/vehicles";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useCompanyContext } from "@/lib/hooks/use-company-context";
import { useTranslation } from "@/hooks/useTranslation";

const ROLES: CompanyRole[] = ["owner", "dispatcher", "driver"];
const JOB_STATUSES: JobStatus[] = [
  "requested",
  "offered",
  "accepted",
  "picked_up",
  "in_transit",
  "delivered",
  "cancelled",
];

function StatsBody() {
  const { t } = useTranslation();
  const ctx = useCompanyContext();

  const companyId = ctx.selectedCompanyId;
  const canStats = ctx.can("stats:read");
  const enabled = ctx.canUsePrivateApi && companyId !== null && canStats;

  const jobsQuery = useQuery({
    queryKey: queryKeys.jobs.list("sender"),
    queryFn: () => fetchJobs({ role: "sender", limit: 100 }),
    enabled,
  });

  const vehiclesQuery = useQuery({
    queryKey: companyId
      ? queryKeys.companies.vehicles(companyId)
      : ["companies", "none", "vehicles"],
    queryFn: () => fetchVehicles(companyId as string),
    enabled,
  });

  const jobs = jobsQuery.data?.data ?? [];

  const statusCounts = useMemo(() => {
    const counts: Record<JobStatus, number> = {
      requested: 0,
      offered: 0,
      accepted: 0,
      picked_up: 0,
      in_transit: 0,
      delivered: 0,
      cancelled: 0,
    };
    for (const job of jobs) counts[job.status] += 1;
    return counts;
  }, [jobs]);

  const roleCounts = useMemo(() => {
    const counts: Record<CompanyRole, number> = {
      owner: 0,
      dispatcher: 0,
      driver: 0,
    };
    for (const m of ctx.company?.members ?? []) counts[m.role] += 1;
    return counts;
  }, [ctx.company]);

  if (ctx.isLoadingCompanies) {
    return (
      <View className="items-center py-16">
        <ActivityIndicator />
      </View>
    );
  }
  if (ctx.companies.length === 0) return <NoCompaniesState />;

  const company = ctx.company;
  const maxStatus = Math.max(1, ...Object.values(statusCounts));
  const maxRole = Math.max(1, ...Object.values(roleCounts));
  const activeVehicles =
    vehiclesQuery.data?.filter((v) => v.status === "active").length ?? 0;

  return (
    <View className="gap-6 px-5 py-8 md:px-8">
      <CompanyHeader
        title={t("nav.stats")}
        companies={ctx.companies}
        selectedCompanyId={ctx.selectedCompanyId}
        onSelect={ctx.selectCompany}
      />

      {!canStats ? (
        <PermissionDenied message={t("stats.readDenied")} />
      ) : (
        <>
          {/* Headline aggregates from the company document. */}
          <View className="gap-3 md:flex-row md:flex-wrap">
            <View className="flex-row gap-3">
              <StatCard
                label={t("stats.completedJobs")}
                value={company ? String(company.completedJobs) : "—"}
                icon={CheckCircle2}
                loading={ctx.isLoadingCompany}
              />
              <StatCard
                label={t("home.kpi.rating")}
                value={company ? company.rating.toFixed(1) : "—"}
                icon={Star}
                loading={ctx.isLoadingCompany}
              />
            </View>
            <View className="flex-row gap-3">
              <StatCard
                label={t("stats.reviews")}
                value={company ? String(company.reviewCount) : "—"}
                icon={MessageSquare}
                loading={ctx.isLoadingCompany}
              />
              <StatCard
                label={t("home.kpi.activeVehicles")}
                value={String(activeVehicles)}
                icon={Truck}
                loading={vehiclesQuery.isPending}
              />
            </View>
          </View>

          {/* Jobs by status (from the operator's recent jobs sample). */}
          <Card className="gap-1 p-4">
            <Text className="pb-2 text-base font-semibold text-surface-foreground">
              {t("stats.jobsByStatus")}
            </Text>
            {jobsQuery.isPending ? (
              <View className="items-center py-8">
                <ActivityIndicator />
              </View>
            ) : jobs.length === 0 ? (
              <Text className="py-6 text-center text-sm text-muted-foreground">
                {t("stats.noJobsSample")}
              </Text>
            ) : (
              JOB_STATUSES.map((s) => (
                <BarRow
                  key={s}
                  label={t(`dispatch.status.${s}`)}
                  value={statusCounts[s]}
                  max={maxStatus}
                />
              ))
            )}
            <Text className="pt-2 text-xs text-muted-foreground">
              {t("stats.jobsSampleNote")}
            </Text>
          </Card>

          {/* Team composition by role. */}
          <Card className="gap-1 p-4">
            <Text className="pb-2 text-base font-semibold text-surface-foreground">
              {t("stats.teamByRole")}
            </Text>
            {ROLES.map((r) => (
              <BarRow
                key={r}
                label={t(`members.role.${r}`)}
                value={roleCounts[r]}
                max={maxRole}
              />
            ))}
          </Card>
        </>
      )}
    </View>
  );
}

export default function StatsScreen() {
  return (
    <DashboardScreen title="Stats · Moovo Hub">
      <StatsBody />
    </DashboardScreen>
  );
}
