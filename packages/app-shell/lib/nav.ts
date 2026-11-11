import type { BloomIconComponent } from '@oxy.so/bloom/icons';

/** One destination of an app's shell, rendered by both the desktop {@link NavRail} and the mobile {@link BottomTabBar}. */
export interface NavItem {
  key: string;
  /** Accessible label and the text under the icon. */
  label: string;
  icon: BloomIconComponent;
  /** The route this item navigates to; `/` is the home item. */
  href: string;
}

/** Whether `pathname` (expo-router's `usePathname()`) marks `item` active: home matches the root and group-index variants, the rest their route and its sub-routes. */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.href === '/') {
    return pathname === '/' || pathname.replace('/(app)', '') === '';
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
