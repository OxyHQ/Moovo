import { View } from "react-native";
import type { JobStatus } from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { useTranslation } from "@/hooks/useTranslation";
import { jobStatusKey } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A job-status pill. Color encodes the lifecycle stage: live/active stages use
 * the brand/amber/blue palette; terminal `delivered` is green-ish (success) and
 * `cancelled` is muted/destructive. Colors come from the Bloom token classes so
 * they track the active theme; no hardcoded hex.
 */
const STATUS_CLASSES: Record<JobStatus, string> = {
  requested: "bg-muted",
  offered: "bg-primary/15",
  accepted: "bg-primary/15",
  picked_up: "bg-primary/15",
  in_transit: "bg-primary/15",
  delivered: "bg-primary/10",
  cancelled: "bg-destructive/10",
};

const STATUS_TEXT_CLASSES: Record<JobStatus, string> = {
  requested: "text-muted-foreground",
  offered: "text-primary",
  accepted: "text-primary",
  picked_up: "text-primary",
  in_transit: "text-primary",
  delivered: "text-primary",
  cancelled: "text-destructive",
};

export function StatusChip({ status }: { status: JobStatus }) {
  const { t } = useTranslation();
  return (
    <View
      className={cn(
        "self-start rounded-full px-2.5 py-1",
        STATUS_CLASSES[status],
      )}
    >
      <Text
        className={cn(
          "text-xs font-semibold",
          STATUS_TEXT_CLASSES[status],
        )}
        numberOfLines={1}
      >
        {t(jobStatusKey(status))}
      </Text>
    </View>
  );
}
