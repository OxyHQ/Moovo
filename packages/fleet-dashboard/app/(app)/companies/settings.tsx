import { type ReactNode, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Company, UpdateCompanyInput, CurrencyCode } from '@moovo/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { ColorSwatchPicker } from '@oxy.so/bloom/color-swatch-picker';
import { Field } from '@oxy.so/bloom/field';
import { Textarea } from '@oxy.so/bloom/textarea';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { FormScreen } from '@/components/dashboard/FormScreen';
import { BRAND_COLORS } from '@/lib/brand-colors';
import { PermissionDenied } from '@/components/dashboard/CompanyHeader';
import { toast } from '@oxy.so/bloom/toast';
import { updateCompany } from '@/lib/api/companies';
import { queryKeys } from '@/lib/hooks/query-keys';
import { useCompanyContext } from '@/lib/hooks/use-company-context';
import { useTranslation } from '@moovo/app-shell/hooks/useTranslation';

const CURRENCIES: CurrencyCode[] = ['USD', 'EUR', 'GBP'];
const STATUSES: Company['status'][] = ['active', 'suspended', 'closed'];

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

/** The editable settings form, mounted once the company is loaded. */
function SettingsForm({ company }: { company: Company }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [description, setDescription] = useState(company.description);
  const [brandColor, setBrandColor] = useState(company.brandColor);
  const [currency, setCurrency] = useState<CurrencyCode>(company.defaultCurrency);
  const [status, setStatus] = useState<Company['status']>(company.status);

  const mutation = useMutation({
    mutationFn: (input: UpdateCompanyInput) => updateCompany(company.id, input),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.companies.detail(company.id), updated);
      void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      toast.success(t('companyForm.saved'));
    },
    onError: (err) => {
      toast.error(errorMessage(err, t('companyForm.saveFailed')));
    },
  });

  // Only send the fields that actually changed (the API requires ≥1 field).
  const buildPatch = (): UpdateCompanyInput => {
    const patch: UpdateCompanyInput = {};
    const trimmedDescription = description.trim();
    if (trimmedDescription !== company.description) patch.description = trimmedDescription;
    if (brandColor !== company.brandColor) patch.brandColor = brandColor;
    if (currency !== company.defaultCurrency) patch.defaultCurrency = currency;
    if (status !== company.status) patch.status = status;
    return patch;
  };

  const patch = buildPatch();
  const hasChanges = Object.keys(patch).length > 0;
  const canSubmit = hasChanges && !mutation.isPending;

  return (
    <>
      <Field label={t('companyForm.name')}>
        <Text>{company.name}</Text>
        <Text>{t('companyForm.identityInOxy')}</Text>
      </Field>

      <Textarea
        label={t('companyForm.description')}
        hint={t('companyForm.descriptionHelper')}
        value={description}
        onValueChange={setDescription}
        placeholder={t('companyForm.descriptionPlaceholder')}
        maxLength={5000}
      />

      <Field label={t('companyForm.brandColor')} multiple>
        <ColorSwatchPicker
          label={t('companyForm.brandColor')}
          value={brandColor}
          onValueChange={setBrandColor}
          colors={BRAND_COLORS.map(({ hex }) => hex)}
          names={Object.fromEntries(
            BRAND_COLORS.map(({ hex, name }) => [hex, t(`companyForm.colors.${name}`)]),
          )}
        />
      </Field>

      <Field label={t('companyForm.currency')}>
        <SegmentedControl
          label={t('companyForm.currency')}
          type="radio"
          value={currency}
          onValueChange={(v) => {
            if (typeof v === 'string' && v) setCurrency(v as CurrencyCode);
          }}
        >
          {CURRENCIES.map((c) => (
            <SegmentedControlItem key={c} value={c}>
              <SegmentedControlItemText>{c}</SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </Field>

      <Field label={t('companyForm.status')}>
        <SegmentedControl
          label={t('companyForm.status')}
          type="radio"
          value={status}
          onValueChange={(v) => {
            if (typeof v === 'string' && v) setStatus(v as Company['status']);
          }}
        >
          {STATUSES.map((s) => (
            <SegmentedControlItem key={s} value={s}>
              <SegmentedControlItemText>{t(`companies.status.${s}`)}</SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </Field>

      <Button
        className="mt-2"
        onPress={() => mutation.mutate(patch)}
        disabled={!canSubmit}
        loading={mutation.isPending}
      >
        {t('common.save')}
      </Button>
    </>
  );
}

export default function CompanySettingsScreen() {
  const { t } = useTranslation();
  const ctx = useCompanyContext();

  let body: ReactNode;
  if (ctx.isLoadingCompanies || ctx.isLoadingCompany) {
    body = (
      <View className="items-center py-16">
        <Loading variant="spinner" />
      </View>
    );
  } else if (!ctx.company) {
    body = (
      <Text className="py-16 text-center text-sm text-muted-foreground">
        {t('companies.loadError')}
      </Text>
    );
  } else if (!ctx.can('company:manage')) {
    body = <PermissionDenied message={t('companyForm.manageDenied')} />;
  } else {
    body = <SettingsForm company={ctx.company} />;
  }

  return <FormScreen title={t('companyForm.settingsTitle')}>{body}</FormScreen>;
}
