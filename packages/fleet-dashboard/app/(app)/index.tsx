import { View, ActivityIndicator } from "react-native";
import { Link } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  Truck,
  CheckCircle2,
  Star,
  Package,
  Users,
} from "lucide-react-native";
import type { JobSummary } from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DashboardScreen } from "@/components/dashboard/DashboardScreen";
import { CompanySelector } from "@/components/dashboard/CompanySelector";
import { StatCard } from "@/components/dashboard/StatCard";
import { StatusChip } from "@/components/dashboard/StatusChip";
import { NoCompaniesState } from "@/components/dashboard/CompanyHeader";
import { useCompanyContext } from "@/lib/hooks/use-company-context";
import { useJobSocket } from "@/lib/hooks/use-job-socket";
import { fetchJobs } from "@/lib/api/jobs";
import { fetchVehicles } from "@/lib/api/vehicles";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useTranslation } from "@/hooks/useTranslation";
import { formatMoney, formatTime, isActiveJob, jobTypeKey } from "@/lib/format";
import { useI18nStore } from "@/lib/stores/i18n-store";

/** Whether an ISO instant falls on today's local date. */
function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/** One recent-job row in the overview list. */
function RecentJobRow({ job }: { job: JobSummary }) {
  const { t } = useTranslation();
  const locale = useI18nStore((s) => s.locale);
  return (
    <Link href={{ pathname: "/jobs/[id]", params: { id: job.id } }} asChild>
      <View className="flex-row items-center gap-3 border-b border-border px-1 py-3 web:cursor-pointer web:hover:bg-accent/40">
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-semibold text-surface-foreground" numberOfLines={1}>
            {job.jobNumber}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {t(jobTypeKey(job.type))} · {formatTime(job.createdAt, locale)}
          </Text>
        </View>
        <Text className="text-sm font-medium text-surface-foreground">
          {formatMoney(job.totals.total)}
        </Text>
        <StatusChip status={job.status} />
      </View>
    </Link>
  );
}

function HomeBody() {
  const { t } = useTranslation();
  const ctx = useCompanyContext();

  // Live job stream once a company is selected (drives KPIs/recent refresh).
  const hasCompany = ctx.selectedCompanyId !== null;
  useJobSocket(ctx.canUsePrivateApi && hasCompany);

  const jobsQuery = useQuery({
    queryKey: queryKeys.jobs.list("sender"),
    queryFn: () => fetchJobs({ role: "sender", limit: 50 }),
    enabled: ctx.canUsePrivateApi && hasCompany,
  });

  const vehiclesQuery = useQuery({
    queryKey: ctx.selectedCompanyId
      ? queryKeys.companies.vehicles(ctx.selectedCompanyId)
      : ["companies", "none", "vehicles"],
    queryFn: () => fetchVehicles(ctx.selectedCompanyId as string),
    enabled: ctx.canUsePrivateApi && hasCompany,
  });

  if (ctx.isLoadingCompanies) {
    return (
      <View className="items-center py-16">
        <ActivityIndicator />
      </View>
    );
  }

  if (ctx.isCompaniesError) {
    return (
      <View className="items-center gap-3 py-16">
        <Text className="text-center text-base text-muted-foreground">
          {t("companies.loadError")}
        </Text>
        <Button variant="outline" onPress={ctx.refetchCompanies}>
          <Text className="text-sm font-medium text-foreground">
            {t("common.tryAgain")}
          </Text>
        </Button>
      </View>
    );
  }

  if (ctx.companies.length === 0) {
    return <NoCompaniesState />;
  }

  const company = ctx.company;
  const jobs = jobsQuery.data?.data ?? [];
  const activeJobs = jobs.filter((j) => isActiveJob(j.status)).length;
  const completedToday = jobs.filter(
    (j) => j.status === "delivered" && isToday(j.createdAt),
  ).length;
  const activeVehicles =
    vehiclesQuery.data?.filter((v) => v.status === "active").length ?? 0;

  return (
    <View className="gap-6 px-5 py-8 md:px-8">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-2xl font-bold text-foreground" numberOfLines={1}>
          {company?.name ?? t("home.title")}
        </Text>
        <Link href="/companies/new" asChild>
          <Button variant="outline" size="sm">
            <Text className="text-sm font-medium text-foreground">
              {t("companies.createCompany")}
            </Text>
          </Button>
        </Link>
      </View>

      <CompanySelector
        companies={ctx.companies}
        selectedCompanyId={ctx.selectedCompanyId}
        onSelect={ctx.selectCompany}
      />

      {/* KPI grid */}
      <View className="gap-3 md:flex-row md:flex-wrap">
        <View className="flex-row gap-3">
          <StatCard
            label={t("home.kpi.activeJobs")}
            value={String(activeJobs)}
            icon={Package}
            loading={jobsQuery.isPending}
          />
          <StatCard
            label={t("home.kpi.activeVehicles")}
            value={String(activeVehicles)}
            icon={Truck}
            loading={vehiclesQuery.isPending}
          />
        </View>
        <View className="flex-row gap-3">
          <StatCard
            label={t("home.kpi.completedToday")}
            value={String(completedToday)}
            icon={CheckCircle2}
            loading={jobsQuery.isPending}
          />
          <StatCard
            label={t("home.kpi.rating")}
            value={company ? company.rating.toFixed(1) : "—"}
            caption={
              company
                ? t("home.kpi.reviewsCount", { count: company.reviewCount })
                : undefined
            }
            icon={Star}
            loading={ctx.isLoadingCompany}
          />
        </View>
      </View>

      {/* Quick links */}
      <View className="flex-row flex-wrap gap-2">
        <Link href="/dispatch" asChild>
          <Button variant="secondary" size="sm">
            <Text className="text-sm font-medium text-secondary-foreground">
              {t("nav.dispatch")}
            </Text>
          </Button>
        </Link>
        <Link href="/fleet" asChild>
          <Button variant="secondary" size="sm">
            <Text className="text-sm font-medium text-secondary-foreground">
              {t("nav.fleet")}
            </Text>
          </Button>
        </Link>
        <Link href="/members" asChild>
          <Button variant="secondary" size="sm">
            <Text className="text-sm font-medium text-secondary-foreground">
              {t("nav.members")}
            </Text>
          </Button>
        </Link>
      </View>

      {/* Recent jobs */}
      <Card className="gap-1 p-4">
        <View className="flex-row items-center justify-between pb-2">
          <Text className="text-base font-semibold text-surface-foreground">
            {t("home.recentJobs")}
          </Text>
          <View className="flex-row items-center gap-1.5">
            <Users size={14} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">
              {t("companies.membersCount", {
                count: company?.members.length ?? 0,
              })}
            </Text>
          </View>
        </View>
        {jobsQuery.isPending ? (
          <View className="items-center py-10">
            <ActivityIndicator />
          </View>
        ) : jobs.length === 0 ? (
          <Text className="py-8 text-center text-sm text-muted-foreground">
            {t("home.noRecentJobs")}
          </Text>
        ) : (
          jobs.slice(0, 8).map((job) => <RecentJobRow key={job.id} job={job} />)
        )}
      </Card>
    </View>
  );
}

export default function HomeScreen() {
  return (
    <DashboardScreen title="Moovo Hub">
      <HomeBody />
    </DashboardScreen>
  );
}
