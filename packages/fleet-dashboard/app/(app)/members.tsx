import { useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import { UserPlus, Trash2 } from "lucide-react-native";
import type {
  Company,
  CompanyMember,
  CompanyRole,
} from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { DashboardScreen } from "@/components/dashboard/DashboardScreen";
import {
  CompanyHeader,
  NoCompaniesState,
  PermissionDenied,
} from "@/components/dashboard/CompanyHeader";
import { UserCell } from "@/components/dashboard/UserCell";
import { toast } from "@/components/sonner";
import {
  fetchMembers,
  inviteMember,
  updateMember,
  removeMember,
} from "@/lib/api/members";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useCompanyContext } from "@/lib/hooks/use-company-context";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";
import { ownerCount } from "@/lib/permissions";
import { formatDate } from "@/lib/format";
import { useI18nStore } from "@/lib/stores/i18n-store";

const ROLES: CompanyRole[] = ["owner", "dispatcher", "driver"];

/** Extract a human message from an axios/API error. */
function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "response" in err) {
    const data = (err as { response?: { data?: { message?: string; error?: string } } })
      .response?.data;
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
  const { colors } = useColorScheme();
  const locale = useI18nStore((s) => s.locale);

  // The last owner cannot be demoted or removed (mirrors the server invariant).
  const isLastOwner = member.role === "owner" && ownerCount(company) === 1;

  return (
    <View className="gap-3 border-b border-border py-4">
      <View className="flex-row items-center justify-between gap-3">
        <View className="min-w-0 flex-1">
          <UserCell oxyUserId={member.oxyUserId} />
        </View>
        <Button
          variant="ghost"
          size="icon"
          onPress={() => onRemove(member)}
          disabled={busy || isLastOwner}
          className="h-9 w-9 rounded-full"
          accessibilityLabel={t("members.remove")}
        >
          <Trash2 size={18} color={colors.mutedForeground} />
        </Button>
      </View>

      <ToggleGroup
        type="single"
        value={member.role}
        onValueChange={(v) => {
          if (typeof v === "string" && v && v !== member.role && !isLastOwner) {
            onChangeRole(member.oxyUserId, v as CompanyRole);
          }
        }}
      >
        <View className="flex-row flex-wrap gap-2">
          {ROLES.map((role) => (
            <ToggleGroupItem
              key={role}
              value={role}
              className="items-center"
            >
              {t(`members.role.${role}`)}
            </ToggleGroupItem>
          ))}
        </View>
      </ToggleGroup>

      <Text className="text-xs text-muted-foreground">
        {t("members.joinedOn", { date: formatDate(member.joinedAt, locale) })}
      </Text>
    </View>
  );
}

/** Invite form: a username (resolved to an Oxy id) + a starting role. */
function InviteForm({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const queryClient = useQueryClient();

  const [username, setUsername] = useState("");
  const [role, setRole] = useState<CompanyRole>("driver");

  const mutation = useMutation({
    mutationFn: async () => {
      const handle = username.trim().replace(/^@/, "");
      // Resolve the username to a canonical Oxy user id — the invite contract
      // is keyed by `oxyUserId`, so the username is looked up first.
      const profile = await oxyServices.getProfileByUsername(handle);
      return inviteMember(companyId, { oxyUserId: profile.id, role });
    },
    onSuccess: (members) => {
      queryClient.setQueryData(queryKeys.companies.members(companyId), members);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.companies.detail(companyId),
      });
      setUsername("");
      toast.success(t("members.inviteSuccess"));
    },
    onError: (err) => {
      toast.error(errorMessage(err, t("members.inviteFailed")));
    },
  });

  const canSubmit = username.trim().length > 0 && !mutation.isPending;

  return (
    <Card className="gap-3 p-4">
      <Text className="text-base font-semibold text-surface-foreground">
        {t("members.inviteTitle")}
      </Text>
      <Input
        value={username}
        onChangeText={setUsername}
        placeholder={t("members.usernamePlaceholder")}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <ToggleGroup
        type="single"
        value={role}
        onValueChange={(v) => {
          if (typeof v === "string" && v) setRole(v as CompanyRole);
        }}
      >
        <View className="flex-row flex-wrap gap-2">
          {ROLES.map((r) => (
            <ToggleGroupItem key={r} value={r} className="items-center">
              {t(`members.role.${r}`)}
            </ToggleGroupItem>
          ))}
        </View>
      </ToggleGroup>
      <Button
        onPress={() => mutation.mutate()}
        disabled={!canSubmit}
        isLoading={mutation.isPending}
      >
        <View className="flex-row items-center gap-2">
          <UserPlus size={16} className="text-primary-foreground" />
          <Text className="text-sm font-medium text-primary-foreground">
            {t("members.inviteButton")}
          </Text>
        </View>
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
  const canManage = ctx.can("members:manage");

  const membersQuery = useQuery({
    queryKey: companyId
      ? queryKeys.companies.members(companyId)
      : ["companies", "none", "members"],
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
      toast.success(t("members.roleUpdated"));
    },
    onError: (err) => toast.error(errorMessage(err, t("members.updateFailed"))),
  });

  const removeMutation = useMutation({
    mutationFn: (oxyUserId: string) =>
      removeMember(companyId as string, oxyUserId),
    onSuccess: (members) => {
      if (companyId) {
        queryClient.setQueryData(queryKeys.companies.members(companyId), members);
        void queryClient.invalidateQueries({
          queryKey: queryKeys.companies.detail(companyId),
        });
      }
      toast.success(t("members.removed"));
    },
    onError: (err) => toast.error(errorMessage(err, t("members.removeFailed"))),
  });

  if (ctx.isLoadingCompanies) {
    return (
      <View className="items-center py-16">
        <ActivityIndicator />
      </View>
    );
  }
  if (ctx.companies.length === 0) return <NoCompaniesState />;

  const company = ctx.company;
  const members = membersQuery.data ?? company?.members ?? [];

  return (
    <View className="gap-6 px-5 py-8 md:px-8">
      <CompanyHeader
        title={t("nav.members")}
        companies={ctx.companies}
        selectedCompanyId={ctx.selectedCompanyId}
        onSelect={ctx.selectCompany}
      />

      {!canManage ? (
        <PermissionDenied message={t("members.manageDenied")} />
      ) : !company ? (
        <View className="items-center py-16">
          <ActivityIndicator />
        </View>
      ) : (
        <>
          <InviteForm companyId={company.id} />

          <Card className="p-4">
            <Text className="pb-1 text-base font-semibold text-surface-foreground">
              {t("members.listTitle", { count: members.length })}
            </Text>
            {members.map((member) => (
              <MemberRow
                key={member.oxyUserId}
                member={member}
                company={company}
                busy={roleMutation.isPending || removeMutation.isPending}
                onChangeRole={(oxyUserId, role) =>
                  roleMutation.mutate({ oxyUserId, role })
                }
                onRemove={setToRemove}
              />
            ))}
          </Card>
        </>
      )}

      <ConfirmationDialog
        open={toRemove !== null}
        onOpenChange={(open) => {
          if (!open) setToRemove(null);
        }}
        title={t("members.removeTitle")}
        description={t("members.removeConfirm")}
        confirmText={t("members.remove")}
        confirmVariant="destructive"
        loading={removeMutation.isPending}
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
