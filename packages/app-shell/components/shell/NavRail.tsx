import { useCallback } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { ProfileButton, useAuth } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { Rail } from '@oxy.so/bloom/rail';
import { useTheme } from '@oxy.so/bloom/theme';
import { isNavItemActive, type NavItem } from '../../lib/nav';
import { Logo } from '../Logo';

/** The desktop navigation rail: brand mark → home, the destinations, Oxy's account control. */
export function NavRail({ items }: { items: readonly NavItem[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const { colors } = useTheme();
  const { signIn } = useAuth();

  const onSelect = useCallback(
    (key: string) => {
      const item = items.find((candidate) => candidate.key === key);
      if (item) router.push(item.href as Parameters<typeof router.push>[0]);
    },
    [items, router],
  );

  return (
    <Rail
      width={76}
      activeId={items.find((item) => isNavItemActive(item, pathname))?.key}
      onSelect={onSelect}
      header={
        <Button
          appearance="plain"
          tone="neutral"
          iconOnly
          icon={<Logo size={28} />}
          accessibilityLabel="Home"
          onPress={() => router.push('/')}
        />
      }
      items={items.map(({ key, label, icon: Icon }) => ({
        id: key,
        label,
        icon: <Icon width={22} fill={colors.textSecondary} />,
        activeIcon: <Icon width={22} fill={colors.primary} />,
      }))}
      footer={
        <ProfileButton
          expanded={false}
          onAddAccount={() => {
            signIn().catch(() => {});
          }}
        />
      }
    />
  );
}
