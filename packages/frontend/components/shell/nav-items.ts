import { RiClipboardLine } from '@oxy.so/bloom/icons/RiClipboardLine';
import { RiHomeLine } from '@oxy.so/bloom/icons/RiHomeLine';
import { RiSendPlaneLine } from '@oxy.so/bloom/icons/RiSendPlaneLine';
import type { NavItem } from '@moovo/app-shell/lib/nav';

/** The destinations of this app's shell, in rail and tab-bar order. */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'home', label: 'Home', icon: RiHomeLine, href: '/' },
  { key: 'send', label: 'Send', icon: RiSendPlaneLine, href: '/send' },
  {
    key: 'orders',
    label: 'Orders',
    icon: RiClipboardLine,
    href: '/orders',
  },
] as const;
