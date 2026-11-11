import { RiBarChartLine } from '@oxy.so/bloom/icons/RiBarChartLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiHomeLine } from '@oxy.so/bloom/icons/RiHomeLine';
import { RiRadioLine } from '@oxy.so/bloom/icons/RiRadioLine';
import { RiTruckLine } from '@oxy.so/bloom/icons/RiTruckLine';
import type { NavItem } from '@moovo/app-shell/lib/nav';

/** The destinations of this app's shell, in rail and tab-bar order. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'home', label: 'Home', icon: RiHomeLine, href: '/' },
  {
    key: 'dispatch',
    label: 'Dispatch',
    icon: RiRadioLine,
    href: '/dispatch',
  },
  { key: 'fleet', label: 'Fleet', icon: RiTruckLine, href: '/fleet' },
  {
    key: 'members',
    label: 'Members',
    icon: RiGroupLine,
    href: '/members',
  },
  {
    key: 'stats',
    label: 'Stats',
    icon: RiBarChartLine,
    href: '/stats',
  },
] as const;
