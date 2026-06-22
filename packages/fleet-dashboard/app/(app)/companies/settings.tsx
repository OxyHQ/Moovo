import { useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  Company,
  UpdateCompanyInput,
  CurrencyCode,
} from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FormScreen, Field } from "@/components/dashboard/FormScreen";
import { PermissionDenied } from "@/components/dashboard/CompanyHeader";
import { toast } from "@/components/sonner";
import { updateCompany } from "@/lib/api/companies";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useCompanyContext } from "@/lib/hooks/use-company-context";
import { useTranslation } from "@/hooks/useTranslation";

const CURRENCIES: CurrencyCode[] = ["USD", "EUR", "GBP"];
const STATUSES: Company["status"][] = ["active", "suspended", "closed"];

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

/** The editable settings form, mounted once the company is loaded. */
function SettingsForm({ company }: { company: Company }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [name, setName] = useState(company.name);
  const [description, setDescription] = useState(company.description);
  const [brandColor, setBrandColor] = useState(company.brandColor);
  const [currency, setCurrency] = useState<CurrencyCode>(company.defaultCurrency);
  const [status, setStatus] = useState<Company["status"]>(company.status);

  const mutation = useMutation({
    mutationFn: (input: UpdateCompanyInput) => updateCompany(company.id, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.companies.detail(company.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      toast.success(t("companyForm.saved"));
    },
    onError: (err) => {
      toast.error(errorMessage(err, t("companyForm.saveFailed")));
    },
  });

  // Only send the fields that actually changed (the API requires ≥1 field).
  const buildPatch = (): UpdateCompanyInput => {
    const patch: UpdateCompanyInput = {};
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    if (trimmedName && trimmedName !== company.name) patch.name = trimmedName;
    if (trimmedDescription !== company.description)
      patch.description = trimmedDescription;
    if (brandColor !== company.brandColor) patch.brandColor = brandColor;
    if (currency !== company.defaultCurrency) patch.defaultCurrency = currency;
    if (status !== company.status) patch.status = status;
    return patch;
  };

  const patch = buildPatch();
  const hasChanges = Object.keys(patch).length > 0;
  const canSubmit = hasChanges && name.trim().length > 0 && !mutation.isPending;

  return (
    <>
      <Field label={t("companyForm.name")}>
        <Input
          value={name}
          onChangeText={setName}
          placeholder={t("companyForm.namePlaceholder")}
          maxLength={120}
          autoCapitalize="words"
        />
      </Field>

      <Field label={t("companyForm.description")}>
        <Textarea
          value={description}
          onChangeText={setDescription}
          placeholder={t("companyForm.descriptionPlaceholder")}
          maxLength={5000}
        />
      </Field>

      <ColorPicker
        label={t("companyForm.brandColor")}
        selected={brandColor}
        onSelect={setBrandColor}
      />

      <Field label={t("companyForm.currency")}>
        <ToggleGroup
          type="single"
          value={currency}
          onValueChange={(v) => {
            if (typeof v === "string" && v) setCurrency(v as CurrencyCode);
          }}
        >
          <View className="flex-row gap-2">
            {CURRENCIES.map((c) => (
              <ToggleGroupItem key={c} value={c} className="flex-1 items-center">
                {c}
              </ToggleGroupItem>
            ))}
          </View>
        </ToggleGroup>
      </Field>

      <Field label={t("companyForm.status")}>
        <ToggleGroup
          type="single"
          value={status}
          onValueChange={(v) => {
            if (typeof v === "string" && v) setStatus(v as Company["status"]);
          }}
        >
          <View className="flex-row gap-2">
            {STATUSES.map((s) => (
              <ToggleGroupItem key={s} value={s} className="flex-1 items-center">
                {t(`companies.status.${s}`)}
              </ToggleGroupItem>
            ))}
          </View>
        </ToggleGroup>
      </Field>

      <Button
        onPress={() => mutation.mutate(patch)}
        disabled={!canSubmit}
        isLoading={mutation.isPending}
        className="mt-2"
      >
        <Text className="text-sm font-medium text-primary-foreground">
          {t("common.save")}
        </Text>
      </Button>
    </>
  );
}

export default function CompanySettingsScreen() {
  const { t } = useTranslation();
  const ctx = useCompanyContext();

  let body;
  if (ctx.isLoadingCompanies || ctx.isLoadingCompany) {
    body = (
      <View className="items-center py-16">
        <ActivityIndicator />
      </View>
    );
  } else if (!ctx.company) {
    body = (
      <Text className="py-16 text-center text-sm text-muted-foreground">
        {t("companies.loadError")}
      </Text>
    );
  } else if (!ctx.can("company:manage")) {
    body = <PermissionDenied message={t("companyForm.manageDenied")} />;
  } else {
    body = <SettingsForm company={ctx.company} />;
  }

  return <FormScreen title={t("companyForm.settingsTitle")}>{body}</FormScreen>;
}
