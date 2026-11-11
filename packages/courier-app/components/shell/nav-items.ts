import { RiClipboardLine } from '@oxy.so/bloom/icons/RiClipboardLine';
import { RiHomeLine } from '@oxy.so/bloom/icons/RiHomeLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { RiTruckLine } from '@oxy.so/bloom/icons/RiTruckLine';
import type { NavItem } from '@moovo/app-shell/lib/nav';

/** The destinations of this app's shell, in rail and tab-bar order. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'home', label: 'Home', icon: RiHomeLine, href: '/' },
  {
    key: 'jobs',
    label: 'Jobs',
    icon: RiClipboardLine,
    href: '/jobs',
  },
  {
    key: 'vehicles',
    label: 'Vehicles',
    icon: RiTruckLine,
    href: '/vehicles',
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: RiSettings3Line,
    href: '/settings',
  },
] as const;
