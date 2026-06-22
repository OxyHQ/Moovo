import {
  Home,
  Radio,
  Truck,
  Users,
  BarChart3,
  type LucideIcon,
} from "lucide-react-native";

/**
 * Canonical navigation model for the Moovo Hub shell, shared by the desktop
 * {@link NavRail} and the mobile {@link BottomTabBar} so both render the exact
 * same set of destinations.
 *
 * `href` is the route the item points at. `available` marks routes that exist
 * today (all do); pressing an item navigates via `router.push(item.href)`.
 */
export interface NavItem {
  key: string;
  /** Accessible label / tooltip text. */
  label: string;
  icon: LucideIcon;
  /** Intended route. Plain string so route typing stays flexible. */
  href: string;
  /** Whether `href` is a real, navigable route today. */
  available: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "home", label: "Home", icon: Home, href: "/", available: true },
  {
    key: "dispatch",
    label: "Dispatch",
    icon: Radio,
    href: "/dispatch",
    available: true,
  },
  { key: "fleet", label: "Fleet", icon: Truck, href: "/fleet", available: true },
  {
    key: "members",
    label: "Members",
    icon: Users,
    href: "/members",
    available: true,
  },
  {
    key: "stats",
    label: "Stats",
    icon: BarChart3,
    href: "/stats",
    available: true,
  },
] as const;

/**
 * Whether `pathname` (from expo-router's `usePathname()`) should mark the given
 * nav item as active. Home matches the root / group-index variants.
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.key === "home") {
    return (
      pathname === "/" ||
      pathname === "/(app)" ||
      (pathname.startsWith("/(app)") && pathname.replace("/(app)", "") === "")
    );
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * Whether the trailing auth/avatar tab should be marked active. Account/profile
 * routes (`/@handle`) belong to the signed-in user, so they light up the auth
 * tab rather than any nav destination.
 */
export function isAuthTabActive(pathname: string): boolean {
  return pathname.startsWith("/@");
}
