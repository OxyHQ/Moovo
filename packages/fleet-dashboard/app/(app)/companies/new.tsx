import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateCompanyInput, CurrencyCode } from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { ColorPicker, COLOR_OPTIONS } from "@/components/ui/color-picker";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FormScreen, Field } from "@/components/dashboard/FormScreen";
import { toast } from "@/components/sonner";
import { createCompany } from "@/lib/api/companies";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useCompanyStore } from "@/lib/stores/company-store";
import { useTranslation } from "@/hooks/useTranslation";

/** The currencies the backend accepts (mirrors `currencySchema`). */
const CURRENCIES: CurrencyCode[] = ["USD", "EUR", "GBP"];

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

export default function NewCompanyScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const setSelectedCompanyId = useCompanyStore((s) => s.setSelectedCompanyId);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState<string>(COLOR_OPTIONS[0] ?? "#3b82f6");
  const [currency, setCurrency] = useState<CurrencyCode>("USD");

  const mutation = useMutation({
    mutationFn: (input: CreateCompanyInput) => createCompany(input),
    onSuccess: (company) => {
      setSelectedCompanyId(company.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      toast.success(t("companyForm.created"));
      router.replace("/");
    },
    onError: (err) => {
      toast.error(errorMessage(err, t("companyForm.createFailed")));
    },
  });

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !mutation.isPending;

  const onSubmit = () => {
    if (!canSubmit) return;
    const input: CreateCompanyInput = {
      name: trimmedName,
      brandColor,
      defaultCurrency: currency,
    };
    const trimmedDescription = description.trim();
    if (trimmedDescription) input.description = trimmedDescription;
    mutation.mutate(input);
  };

  return (
    <FormScreen title={t("companyForm.createTitle")}>
      <Text className="text-sm text-muted-foreground">
        {t("companyForm.createSubtitle")}
      </Text>

      <Field label={t("companyForm.name")}>
        <Input
          value={name}
          onChangeText={setName}
          placeholder={t("companyForm.namePlaceholder")}
          maxLength={120}
          autoCapitalize="words"
        />
      </Field>

      <Field label={t("companyForm.description")} helper={t("companyForm.descriptionHelper")}>
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

      <Button onPress={onSubmit} disabled={!canSubmit} isLoading={mutation.isPending} className="mt-2">
        <Text className="text-sm font-medium text-primary-foreground">
          {t("companyForm.createButton")}
        </Text>
      </Button>
    </FormScreen>
  );
}
