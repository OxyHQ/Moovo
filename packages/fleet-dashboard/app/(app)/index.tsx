import { View } from 'react-native';
import { Link } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { RiBox3Line } from '@oxy.so/bloom/icons/RiBox3Line';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiStarLine } from '@oxy.so/bloom/icons/RiStarLine';
import { RiTruckLine } from '@oxy.so/bloom/icons/RiTruckLine';
import type { JobSummary } from '@moovo/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { Card } from '@oxy.so/bloom/card';
import { useTheme } from '@oxy.so/bloom/theme';
import { DashboardScreen } from '@/components/dashboard/DashboardScreen';
import { CompanySelector } from '@/components/dashboard/CompanySelector';
import { StatCard } from '@/components/dashboard/StatCard';
import { StatusChip } from '@/components/dashboard/StatusChip';
import { NoCompaniesState } from '@/components/dashboard/CompanyHeader';
import { useCompanyContext } from '@/lib/hooks/use-company-context';
import { useJobSocket } from '@/lib/hooks/use-job-socket';
import { fetchJobs } from '@/lib/api/jobs';
import { fetchVehicles } from '@/lib/api/vehicles';
import { queryKeys } from '@/lib/hooks/query-keys';
import { useTranslation } from '@moovo/app-shell/hooks/useTranslation';
import { formatMoney, formatTime, isActiveJob, jobTypeKey } from '@/lib/format';
import { useI18nStore } from '@moovo/app-shell/lib/stores/i18n-store';

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
    <Link href={{ pathname: '/jobs/[id]', params: { id: job.id } }} asChild>
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
  const { colors } = useTheme();
  const ctx = useCompanyContext();

  // Live job stream once a company is selected (drives KPIs/recent refresh).
  const hasCompany = ctx.selectedCompanyId !== null;
  useJobSocket(ctx.canUsePrivateApi && hasCompany);

  const jobsQuery = useQuery({
    queryKey: queryKeys.jobs.list('sender'),
    queryFn: () => fetchJobs({ role: 'sender', limit: 50 }),
    enabled: ctx.canUsePrivateApi && hasCompany,
  });

  const vehiclesQuery = useQuery({
    queryKey: ctx.selectedCompanyId
      ? queryKeys.companies.vehicles(ctx.selectedCompanyId)
      : ['companies', 'none', 'vehicles'],
    queryFn: () => fetchVehicles(ctx.selectedCompanyId as string),
    enabled: ctx.canUsePrivateApi && hasCompany,
  });

  if (ctx.isLoadingCompanies) {
    return (
      <View className="items-center py-16">
        <Loading variant="spinner" />
      </View>
    );
  }

  if (ctx.isCompaniesError) {
    return (
      <View className="items-center gap-3 py-16">
        <Text className="text-center text-base text-muted-foreground">
          {t('companies.loadError')}
        </Text>
        <Button appearance="outline" tone="neutral" onPress={ctx.refetchCompanies}>
          {t('common.tryAgain')}
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
    (j) => j.status === 'delivered' && isToday(j.createdAt),
  ).length;
  const activeVehicles = vehiclesQuery.data?.filter((v) => v.status === 'active').length ?? 0;

  return (
    <View className="gap-6 px-5 py-8 md:px-8">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-2xl font-bold text-foreground" numberOfLines={1}>
          {company?.name ?? t('home.title')}
        </Text>
        <Link href="/companies/new" asChild>
          <Button appearance="outline" tone="neutral" size="sm">
            {t('companies.createCompany')}
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
            label={t('home.kpi.activeJobs')}
            value={String(activeJobs)}
            icon={RiBox3Line}
            loading={jobsQuery.isPending}
          />
          <StatCard
            label={t('home.kpi.activeVehicles')}
            value={String(activeVehicles)}
            icon={RiTruckLine}
            loading={vehiclesQuery.isPending}
          />
        </View>
        <View className="flex-row gap-3">
          <StatCard
            label={t('home.kpi.completedToday')}
            value={String(completedToday)}
            icon={RiCheckboxCircleLine}
            loading={jobsQuery.isPending}
          />
          <StatCard
            label={t('home.kpi.rating')}
            value={company ? company.rating.toFixed(1) : '—'}
            caption={
              company ? t('home.kpi.reviewsCount', { count: company.reviewCount }) : undefined
            }
            icon={RiStarLine}
            loading={ctx.isLoadingCompany}
          />
        </View>
      </View>

      {/* Quick links */}
      <View className="flex-row flex-wrap gap-2">
        <Link href="/dispatch" asChild>
          <Button appearance="subtle" tone="neutral" size="sm">
            {t('nav.dispatch')}
          </Button>
        </Link>
        <Link href="/fleet" asChild>
          <Button appearance="subtle" tone="neutral" size="sm">
            {t('nav.fleet')}
          </Button>
        </Link>
        <Link href="/members" asChild>
          <Button appearance="subtle" tone="neutral" size="sm">
            {t('nav.members')}
          </Button>
        </Link>
      </View>

      {/* Recent jobs */}
      <Card className="gap-1 p-4">
        <View className="flex-row items-center justify-between pb-2">
          <Text className="text-base font-semibold text-surface-foreground">
            {t('home.recentJobs')}
          </Text>
          <View className="flex-row items-center gap-1.5">
            <RiGroupLine width={14} height={14} fill={colors.textSecondary} />
            <Text className="text-xs text-muted-foreground">
              {t('companies.membersCount', {
                count: company?.members.length ?? 0,
              })}
            </Text>
          </View>
        </View>
        {jobsQuery.isPending ? (
          <View className="items-center py-10">
            <Loading variant="spinner" />
          </View>
        ) : jobs.length === 0 ? (
          <Text className="py-8 text-center text-sm text-muted-foreground">
            {t('home.noRecentJobs')}
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
