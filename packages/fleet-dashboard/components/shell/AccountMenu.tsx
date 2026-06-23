import { useCallback } from "react";
import { useRouter } from "expo-router";
import { Settings, Bell } from "lucide-react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { useTranslation } from "@/hooks/useTranslation";

interface AccountMenuProps {
  /**
   * The avatar control rendered as the menu trigger. Must be a single pressable
   * element (the rail item or the bottom-bar tab).
   */
  children: React.ReactElement;
}

/**
 * The signed-in operator's account menu, shared by the NavRail and the
 * BottomTabBar so both shells behave identically.
 *
 * Rendered ONLY when authenticated (the shells render a bare sign-in pressable
 * when signed out). Opening it reaches Account & settings and Notifications —
 * the two operator routes that were previously unreachable from the live shell.
 *
 * Uses the package's existing `dropdown-menu` primitive (zeego on native, Radix
 * on web), the same one the language selector uses.
 */
export function AccountMenu({ children }: AccountMenuProps) {
  const router = useRouter();
  const { t } = useTranslation();

  const goSettings = useCallback(() => router.push("/settings"), [router]);
  const goNotifications = useCallback(
    () => router.push("/notifications"),
    [router],
  );

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.Item key="settings" onSelect={goSettings}>
          <DropdownMenu.ItemIcon ios={{ name: "gearshape" }}>
            <Settings size={16} />
          </DropdownMenu.ItemIcon>
          <DropdownMenu.ItemTitle>
            {t("account.settings")}
          </DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
        <DropdownMenu.Item key="notifications" onSelect={goNotifications}>
          <DropdownMenu.ItemIcon ios={{ name: "bell" }}>
            <Bell size={16} />
          </DropdownMenu.ItemIcon>
          <DropdownMenu.ItemTitle>
            {t("account.notifications")}
          </DropdownMenu.ItemTitle>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
