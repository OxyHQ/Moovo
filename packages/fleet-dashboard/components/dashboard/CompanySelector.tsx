import { View } from 'react-native';
import type { Company } from '@moovo/shared-types';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { useTranslation } from '@moovo/app-shell/hooks/useTranslation';

interface CompanySelectorProps {
  companies: Company[];
  selectedCompanyId: string | null;
  onSelect: (companyId: string) => void;
}

/** One chip per company the operator administers, the active one selected. Only shown when the operator belongs to more than one. */
export function CompanySelector({ companies, selectedCompanyId, onSelect }: CompanySelectorProps) {
  const { t } = useTranslation();
  if (companies.length <= 1) return null;

  return (
    <ChipRow role="radiogroup" accessibilityLabel={t('companies.selectorLabel')}>
      {companies.map((company) => (
        <Chip
          key={company.id}
          size="xl"
          role="radio"
          selected={company.id === selectedCompanyId}
          // `brandColor` is a per-company runtime CSS colour from the API, so the dot is inline.
          startIcon={
            <View
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: company.brandColor }}
            />
          }
          onPress={() => onSelect(company.id)}
        >
          {company.name}
        </Chip>
      ))}
    </ChipRow>
  );
}
