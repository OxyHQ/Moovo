import type { ReactNode } from "react";
import { View } from "react-native";
import { Link } from "expo-router";
import { Lock } from "lucide-react-native";
import type { Company } from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { CompanySelector } from "@/components/dashboard/CompanySelector";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";

interface CompanyHeaderProps {
  /** Page title (e.g. "Members"). */
  title: string;
  companies: Company[];
  selectedCompanyId: string | null;
  onSelect: (companyId: string) => void;
  /** Optional trailing action(s) (e.g. an "Add vehicle" button). */
  action?: ReactNode;
}

/**
 * Shared header for every company-scoped page: the page title, the company chip
 * selector (only when the operator administers more than one), and an optional
 * trailing action slot.
 */
export function CompanyHeader({
  title,
  companies,
  selectedCompanyId,
  onSelect,
  action,
}: CompanyHeaderProps) {
  return (
    <View className="gap-4">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-2xl font-bold text-foreground">{title}</Text>
        {action}
      </View>
      <CompanySelector
        companies={companies}
        selectedCompanyId={selectedCompanyId}
        onSelect={onSelect}
      />
    </View>
  );
}

/**
 * Branded "create your first company" empty state, shown on company-scoped pages
 * when the operator has no companies yet.
 */
export function NoCompaniesState() {
  const { t } = useTranslation();
  return (
    <View className="items-center gap-4 py-16">
      <Text className="text-center text-lg font-semibold text-foreground">
        {t("home.emptyTitle")}
      </Text>
      <Text className="max-w-md text-center text-base text-muted-foreground">
        {t("home.emptySubtitle")}
      </Text>
      <Link href="/companies/new" asChild>
        <Button>
          <Text className="text-sm font-medium text-primary-foreground">
            {t("companies.createCompany")}
          </Text>
        </Button>
      </Link>
    </View>
  );
}

/**
 * Permission-denied panel, shown when the caller lacks the permission a page
 * requires. The API still enforces the gate; this is the matching UI affordance.
 */
export function PermissionDenied({ message }: { message?: string }) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  return (
    <View className="items-center gap-3 py-16">
      <View className="h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Lock size={22} color={colors.mutedForeground} />
      </View>
      <Text className="text-center text-base font-semibold text-foreground">
        {t("common.permissionDeniedTitle")}
      </Text>
      <Text className="max-w-md text-center text-sm text-muted-foreground">
        {message ?? t("common.permissionDeniedBody")}
      </Text>
    </View>
  );
}
