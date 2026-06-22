import { View, Pressable, ScrollView } from "react-native";
import type { Company } from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

interface CompanySelectorProps {
  companies: Company[];
  selectedCompanyId: string | null;
  onSelect: (companyId: string) => void;
}

/**
 * Horizontal company chip selector. Renders one chip per company the operator
 * administers, highlighting the active one. Works identically on web and native
 * (a horizontally-scrolling row of pressables — no platform-specific menu). Only
 * shown when the operator belongs to more than one company.
 */
export function CompanySelector({
  companies,
  selectedCompanyId,
  onSelect,
}: CompanySelectorProps) {
  if (companies.length <= 1) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 py-1"
    >
      {companies.map((company) => {
        const active = company.id === selectedCompanyId;
        return (
          <Pressable
            key={company.id}
            onPress={() => onSelect(company.id)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            className={cn(
              "flex-row items-center gap-2 rounded-full border px-3.5 py-2",
              active
                ? "border-primary bg-primary/10"
                : "border-border bg-background web:hover:bg-accent",
            )}
          >
            {/* Brand accent dot — `brandColor` is a per-company runtime CSS color
                from the API; no NativeWind class can express an arbitrary color,
                so an inline backgroundColor is correct here. */}
            <View
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: company.brandColor }}
            />
            <Text
              className={cn(
                "text-sm font-medium",
                active ? "text-primary" : "text-foreground",
              )}
              numberOfLines={1}
            >
              {company.name}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
