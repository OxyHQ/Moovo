import { useState } from 'react';
import { useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateCompanyInput, CurrencyCode } from '@moovo/shared-types';
import { Text } from '@oxy.so/bloom/typography';
import { ColorSwatchPicker } from '@oxy.so/bloom/color-swatch-picker';
import { Field } from '@oxy.so/bloom/field';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { Textarea } from '@oxy.so/bloom/textarea';
import { Button } from '@oxy.so/bloom/button';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { FormScreen } from '@/components/dashboard/FormScreen';
import { BRAND_COLORS } from '@/lib/brand-colors';
import { toast } from '@oxy.so/bloom/toast';
import { createCompany } from '@/lib/api/companies';
import { queryKeys } from '@/lib/hooks/query-keys';
import { useCompanyStore } from '@/lib/stores/company-store';
import { useTranslation } from '@moovo/app-shell/hooks/useTranslation';

/** The currencies the backend accepts (mirrors `currencySchema`). */
const CURRENCIES: CurrencyCode[] = ['USD', 'EUR', 'GBP'];

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

export default function NewCompanyScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const setSelectedCompanyId = useCompanyStore((s) => s.setSelectedCompanyId);

  const { oxyServices, canUsePrivateApi, user } = useOxy();
  const [accountId, setAccountId] = useState('');
  const accounts = useQuery({
    queryKey: ['fleetRegistrationAccounts', user?.id],
    enabled: canUsePrivateApi,
    queryFn: async () => {
      const nodes = await oxyServices.accounts.list();
      // The organizations the API will let this person register: the same
      // `account:update` permission it asks Oxy for (grants and revokes applied).
      const ids = nodes
        .filter(
          (node) =>
            node.kind === 'organization' &&
            node.callerMembership?.status === 'active' &&
            node.callerMembership.permissions.includes('account:update'),
        )
        .map((node) => node.accountId);
      const organizations = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const response = await oxyServices.organizations.batch({
          ids: ids.slice(offset, offset + 100),
        });
        organizations.push(...response.items.map((item) => item.organization));
      }
      return organizations.filter(
        (org) => org.status === 'active' && org.claimStatus === 'claimed',
      );
    },
  });
  const organizations = (accounts.data ?? []).map(({ accountId, name }) => ({
    value: accountId,
    label: name,
  }));
  const [description, setDescription] = useState('');
  const [brandColor, setBrandColor] = useState<string>(BRAND_COLORS[0].hex);
  const [currency, setCurrency] = useState<CurrencyCode>('USD');

  const mutation = useMutation({
    mutationFn: (input: CreateCompanyInput) => createCompany(input),
    onSuccess: (company) => {
      setSelectedCompanyId(company.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      toast.success(t('companyForm.created'));
      router.replace('/');
    },
    onError: (err) => {
      toast.error(errorMessage(err, t('companyForm.createFailed')));
    },
  });

  const canSubmit = Boolean(accountId) && canUsePrivateApi && !mutation.isPending;

  const onSubmit = () => {
    if (!canSubmit) return;
    const input: CreateCompanyInput = {
      oxyAccountId: accountId,
      brandColor,
      defaultCurrency: currency,
    };
    const trimmedDescription = description.trim();
    if (trimmedDescription) input.description = trimmedDescription;
    mutation.mutate(input);
  };

  return (
    <FormScreen title={t('companyForm.createTitle')}>
      <Text className="text-sm text-muted-foreground">{t('companyForm.createSubtitle')}</Text>

      <Field label={t('companyForm.organization')}>
        {accounts.isError ? <Text>{t('companyForm.directoryUnavailable')}</Text> : null}
        {accounts.isSuccess && accounts.data.length === 0 ? (
          <Text>{t('companyForm.noOrganizations')}</Text>
        ) : null}
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger label={t('companyForm.organization')}>
            <SelectValue placeholder={t('companyForm.organization')} />
            <SelectIcon />
          </SelectTrigger>
          <SelectContent
            label={t('companyForm.organization')}
            items={organizations}
            renderItem={(item) => (
              <SelectItem value={item.value} label={item.label}>
                <SelectItemIndicator />
                <SelectItemText>{item.label}</SelectItemText>
              </SelectItem>
            )}
          />
        </Select>
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

      <Button
        className="mt-2"
        onPress={onSubmit}
        disabled={!canSubmit}
        loading={mutation.isPending}
      >
        {t('companyForm.createButton')}
      </Button>
    </FormScreen>
  );
}
