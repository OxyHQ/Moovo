import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { Logo } from "@/components/Logo";

const FOOTER_LINKS = ["About", "Help", "Privacy", "Terms"] as const;

/* ================================================================
   Footer — light footer for the home scroll
   ================================================================ */

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <View className="mt-8 border-t border-border px-6 py-8">
      <View className="flex-row items-center gap-2">
        <Logo size={20} />
        <Text className="text-sm font-semibold text-foreground">Moovo</Text>
      </View>

      <View className="mt-4 flex-row flex-wrap items-center gap-4">
        {FOOTER_LINKS.map((link) => (
          <Pressable
            key={link}
            accessibilityRole="button"
            accessibilityLabel={link}
            className="active:opacity-70"
          >
            <Text className="text-sm text-muted-foreground">{link}</Text>
          </Pressable>
        ))}
      </View>

      {/* (TM) and never (R): neither mark is registered yet, and using (R)
          before a registration issues is unlawful in several jurisdictions. */}
      <Text className="mt-4 text-xs text-muted-foreground">
        © {year} Moovo&trade; by Oxy&trade;. Trademarks of The Oxy Collective Inc.
      </Text>
    </View>
  );
}
