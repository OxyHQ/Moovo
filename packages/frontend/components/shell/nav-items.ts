import { Home, Send, ClipboardList, type LucideIcon } from "lucide-react-native";

/**
 * Canonical navigation model for the Moovo customer shell, shared by the desktop
 * {@link NavRail} and the mobile {@link BottomTabBar} so both render the exact
 * same set of destinations.
 *
 * These are the customer (moovo.now) transport destinations:
 *  - Home (`/`)         — the send hub + recent-activity landing.
 *  - Send (`/send`)     — the create-a-shipment flow.
 *  - Orders (`/orders`) — the customer's shipments + booked deliveries list.
 *
 * `href` is the route this item points at; every entry below is a real,
 * navigable route (`available: true`). The trailing auth/avatar tab is rendered
 * by the bars themselves (it is not a nav destination — it opens the sign-in
 * modal or the account), so it is intentionally NOT in this list.
 */
export interface NavItem {
  key: string;
  /** Accessible label / tooltip text. */
  label: string;
  icon: LucideIcon;
  /** The route this item navigates to. */
  href: string;
  /** Whether `href` is a real, navigable route today. */
  available: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "home", label: "Home", icon: Home, href: "/", available: true },
  { key: "send", label: "Send", icon: Send, href: "/send", available: true },
  {
    key: "orders",
    label: "Orders",
    icon: ClipboardList,
    href: "/orders",
    available: true,
  },
] as const;

/**
 * Whether `pathname` (from expo-router's `usePathname()`) should mark the
 * given nav item as active. Home matches the root / group-index variants;
 * other items match their route or any nested sub-route.
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
 * tab rather than any nav destination. Kept here so the `/@` route knowledge
 * lives in the nav model alongside {@link isNavItemActive}, not in the bar.
 */
export function isAuthTabActive(pathname: string): boolean {
  return pathname.startsWith("/@");
}
