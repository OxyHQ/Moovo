import { usePathname, useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services/ui/client';
import { Avatar } from '@oxy.so/bloom/avatar';
import { RiLoginBoxLine } from '@oxy.so/bloom/icons/RiLoginBoxLine';
import { TabBar, TabBarButton } from '@oxy.so/bloom/tab-bar';
import { useTranslation } from '../../hooks/useTranslation';
import { isNavItemActive, type NavItem } from '../../lib/nav';

/**
 * The mobile floating tab bar: the destinations plus a trailing account tab
 * (the signed-in avatar opens settings, signed out it opens Oxy's sign-in).
 */
export function BottomTabBar({ items }: { items: readonly NavItem[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();
  const { isAuthenticated, openAccountDialog, user } = useOxy();

  const accountIndex = items.length;
  const tabs = [
    ...items.map(({ key, label, icon: Icon }) => ({ name: key, label, icon: <Icon /> })),
    {
      name: 'account',
      label: isAuthenticated ? t('account.menuLabel') : t('account.signIn'),
      icon: isAuthenticated ? (
        <Avatar source={user?.avatar} name={user?.username} size={24} />
      ) : (
        <RiLoginBoxLine />
      ),
    },
  ];

  const onIndexChange = (index: number) => {
    if (index !== accountIndex) {
      router.push(items[index].href as Parameters<typeof router.push>[0]);
    } else if (isAuthenticated) {
      router.push('/settings');
    } else {
      openAccountDialog();
    }
  };

  return (
    <TabBar
      activeIndex={items.findIndex((item) => isNavItemActive(item, pathname))}
      onIndexChange={onIndexChange}
    >
      {tabs.map((item, index) => (
        <TabBarButton key={item.name} item={item} index={index} />
      ))}
    </TabBar>
  );
}
