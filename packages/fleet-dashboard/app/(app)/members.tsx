import { useState } from 'react';
import { View } from 'react-native';
import { Link } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiUserAddLine } from '@oxy.so/bloom/icons/RiUserAddLine';
import type { Company, CompanyMember, CompanyRole } from '@moovo/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Card } from '@oxy.so/bloom/card';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { AlertDialog } from '@oxy.so/bloom/alert-dialog';
import { DashboardScreen } from '@/components/dashboard/DashboardScreen';
import {
  CompanyHeader,
  NoCompaniesState,
  PermissionDenied,
} from '@/components/dashboard/CompanyHeader';
import { UserCell } from '@/components/dashboard/UserCell';
import { toast } from '@oxy.so/bloom/toast';
import { fetchMembers, inviteMember, updateMember, removeMember } from '@/lib/api/members';
import { queryKeys } from '@/lib/hooks/query-keys';
import { useCompanyContext } from '@/lib/hooks/use-company-context';
import { useTranslation } from '@moovo/app-shell/hooks/useTranslation';
import { ownerCount } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import { useI18nStore } from '@moovo/app-shell/lib/stores/i18n-store';

const ROLES: CompanyRole[] = ['owner', 'dispatcher', 'driver'];

/** Extract a human message from an axios/API error. */
function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const data = (err as { response?: { data?: { message?: string; error?: string } } }).response
      ?.data;
    if (data?.message) return data.message;
    if (data?.error) return data.error;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** A single member row: identity + role selector + joined date + remove. */
function MemberRow({
  member,
  company,
  onChangeRole,
  onRemove,
  busy,
}: {
  member: CompanyMember;
  company: Company;
  onChangeRole: (oxyUserId: string, role: CompanyRole) => void;
  onRemove: (member: CompanyMember) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const locale = useI18nStore((s) => s.locale);

  // The last owner cannot be demoted or removed (mirrors the server invariant).
  const isLastOwner = member.role === 'owner' && ownerCount(company) === 1;

  return (
    <View className="gap-3 border-b border-border py-4">
      <View className="flex-row items-center justify-between gap-3">
        <View className="min-w-0 flex-1">
          <UserCell oxyUserId={member.oxyUserId} />
        </View>
        <Button
          appearance="plain"
          tone="neutral"
          iconOnly
          className="w-9"
          onPress={() => onRemove(member)}
          disabled={busy || isLastOwner}
          accessibilityLabel={t('members.remove')}
          icon={RiDeleteBinLine}
        />
      </View>

      <SegmentedControl
        label={t('members.role.label')}
        type="radio"
        value={member.role}
        onValueChange={(v) => {
          if (typeof v === 'string' && v && v !== member.role && !isLastOwner) {
            onChangeRole(member.oxyUserId, v as CompanyRole);
          }
        }}
      >
        {ROLES.map((role) => (
          <SegmentedControlItem key={role} value={role}>
            <SegmentedControlItemText>{t(`members.role.${role}`)}</SegmentedControlItemText>
          </SegmentedControlItem>
        ))}
      </SegmentedControl>

      <Text className="text-xs text-muted-foreground">
        {t('members.joinedOn', { date: formatDate(member.joinedAt, locale) })}
      </Text>
    </View>
  );
}

/** Invite form: a username (resolved to an Oxy id) + a starting role. */
function InviteForm({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();

  const [username, setUsername] = useState('');
  const [role, setRole] = useState<CompanyRole>('driver');

  const mutation = useMutation({
    mutationFn: async () => {
      const handle = username.trim().replace(/^@/, '');
      // Resolve the username to a canonical Oxy user id — the invite contract
      // is keyed by `oxyUserId`, so the username is looked up first.
      const profile = await oxyServices.users.byUsername(handle);
      return inviteMember(companyId, { oxyUserId: profile.id, role });
    },
    onSuccess: (members) => {
      queryClient.setQueryData(queryKeys.companies.members(companyId), members);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.companies.detail(companyId),
      });
      setUsername('');
      toast.success(t('members.inviteSuccess'));
    },
    onError: (err) => {
      toast.error(errorMessage(err, t('members.inviteFailed')));
    },
  });

  const canSubmit = username.trim().length > 0 && !mutation.isPending;

  return (
    <Card className="gap-3 p-4">
      <Text className="text-base font-semibold text-surface-foreground">
        {t('members.inviteTitle')}
      </Text>
      <TextFieldInput
        label={t('members.usernamePlaceholder')}
        value={username}
        onValueChange={setUsername}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <SegmentedControl
        label={t('members.role.label')}
        type="radio"
        value={role}
        onValueChange={(v) => {
          if (typeof v === 'string' && v) setRole(v as CompanyRole);
        }}
      >
        {ROLES.map((r) => (
          <SegmentedControlItem key={r} value={r}>
            <SegmentedControlItemText>{t(`members.role.${r}`)}</SegmentedControlItemText>
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      <Button
        onPress={() => mutation.mutate()}
        disabled={!canSubmit}
        loading={mutation.isPending}
        leadingIcon={RiUserAddLine}
      >
        {t('members.inviteButton')}
      </Button>
    </Card>
  );
}

function MembersBody() {
  const { t } = useTranslation();
  const ctx = useCompanyContext();
  const queryClient = useQueryClient();
  const [toRemove, setToRemove] = useState<CompanyMember | null>(null);

  const companyId = ctx.selectedCompanyId;
  const canManage = ctx.can('members:manage');
  const canManageCompany = ctx.can('company:manage');

  const membersQuery = useQuery({
    queryKey: companyId ? queryKeys.companies.members(companyId) : ['companies', 'none', 'members'],
    queryFn: () => fetchMembers(companyId as string),
    enabled: ctx.canUsePrivateApi && companyId !== null && canManage,
    // Seed from the loaded company so the list shows instantly, then refresh.
    initialData: ctx.company?.members,
  });

  const roleMutation = useMutation({
    mutationFn: ({ oxyUserId, role }: { oxyUserId: string; role: CompanyRole }) =>
      updateMember(companyId as string, oxyUserId, { role }),
    onSuccess: (members) => {
      if (companyId) {
        queryClient.setQueryData(queryKeys.companies.members(companyId), members);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.companies.detail(companyId),
        });
      }
      toast.success(t('members.roleUpdated'));
    },
    onError: (err) => toast.error(errorMessage(err, t('members.updateFailed'))),
  });

  const removeMutation = useMutation({
    mutationFn: (oxyUserId: string) => removeMember(companyId as string, oxyUserId),
    onSuccess: (members) => {
      if (companyId) {
        queryClient.setQueryData(queryKeys.companies.members(companyId), members);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.companies.detail(companyId),
        });
      }
      toast.success(t('members.removed'));
    },
    onError: (err) => toast.error(errorMessage(err, t('members.removeFailed'))),
  });

  if (ctx.isLoadingCompanies) {
    return (
      <View className="items-center py-16">
        <Loading variant="spinner" />
      </View>
    );
  }
  if (ctx.companies.length === 0) return <NoCompaniesState />;

  const company = ctx.company;
  const members = membersQuery.data ?? company?.members ?? [];

  return (
    <View className="gap-6 px-5 py-8 md:px-8">
      <CompanyHeader
        title={t('nav.members')}
        companies={ctx.companies}
        selectedCompanyId={ctx.selectedCompanyId}
        onSelect={ctx.selectCompany}
        action={
          canManageCompany ? (
            <Link href="/companies/settings" asChild>
              <Button appearance="outline" tone="neutral" size="sm" leadingIcon={RiSettings3Line}>
                {t('companies.settingsLink')}
              </Button>
            </Link>
          ) : undefined
        }
      />

      {!canManage ? (
        <PermissionDenied message={t('members.manageDenied')} />
      ) : !company ? (
        <View className="items-center py-16">
          <Loading variant="spinner" />
        </View>
      ) : (
        <>
          <InviteForm companyId={company.id} />

          <Card className="p-4">
            <Text className="pb-1 text-base font-semibold text-surface-foreground">
              {t('members.listTitle', { count: members.length })}
            </Text>
            {members.map((member) => (
              <MemberRow
                key={member.oxyUserId}
                member={member}
                company={company}
                busy={roleMutation.isPending || removeMutation.isPending}
                onChangeRole={(oxyUserId, role) => roleMutation.mutate({ oxyUserId, role })}
                onRemove={setToRemove}
              />
            ))}
          </Card>
        </>
      )}

      <AlertDialog
        open={toRemove !== null}
        onOpenChange={(open) => {
          if (!open) setToRemove(null);
        }}
        title={t('members.removeTitle')}
        description={t('members.removeConfirm')}
        confirmLabel={t('members.remove')}
        destructive
        onConfirm={() => {
          if (toRemove) removeMutation.mutate(toRemove.oxyUserId);
        }}
      />
    </View>
  );
}

export default function MembersScreen() {
  return (
    <DashboardScreen title="Members · Moovo Hub">
      <MembersBody />
    </DashboardScreen>
  );
}
