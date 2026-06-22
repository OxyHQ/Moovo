import { View } from 'react-native';
import type { DisplayMoney } from '@moovo/shared-types';
import { Text } from '@/components/ui/text';
import { formatFair, formatFiat } from '@/lib/money';
import { cn } from '@/lib/utils';

/**
 * Render a FAIR {@link DisplayMoney} amount: the canonical FAIR value (⊜ + major
 * amount) with the converted fiat shown as muted secondary text when the API
 * attached a conversion. FAIR is always the primary, source-of-truth figure.
 */
export function MoneyText({
  money,
  size = 'md',
  className,
}: {
  money: DisplayMoney;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const fiat = formatFiat(money);
  const fairClass =
    size === 'lg' ? 'text-2xl font-bold' : size === 'sm' ? 'text-sm font-semibold' : 'text-base font-semibold';
  const fiatClass = size === 'lg' ? 'text-sm' : 'text-xs';

  return (
    <View className={cn('flex-row items-baseline gap-1.5', className)}>
      <Text className={cn(fairClass, 'text-foreground')}>{formatFair(money)}</Text>
      {fiat ? <Text className={cn(fiatClass, 'text-muted-foreground')}>{fiat}</Text> : null}
    </View>
  );
}
