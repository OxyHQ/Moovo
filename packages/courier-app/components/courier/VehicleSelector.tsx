import { View, Pressable, ScrollView, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Check } from "lucide-react-native";
import type { Vehicle } from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Card, CardContent } from "@/components/ui/card";
import { useColorScheme } from "@/lib/useColorScheme";
import { queryKeys } from "@/lib/hooks/query-keys";
import {
  fetchCourierVehicles,
  fetchCourierMe,
  setActiveVehicle,
} from "@/lib/api/courier";
import { VEHICLE_LABELS, VEHICLE_ICONS } from "@/components/courier/vehicle-meta";

/**
 * Active-vehicle picker for the home screen.
 *
 * Lists the courier's vehicles as a horizontal row of chips; tapping one sets it
 * active via `POST /courier/active-vehicle`, which the backend uses to recompute
 * the courier's capability (eligible job types). The currently-active vehicle is
 * read from the courier profile. A trailing "Add" chip routes to the vehicles
 * screen. Empty state nudges the courier to add their first vehicle.
 */

interface VehicleSelectorProps {
  /** Whether the private (bearer) API is ready to be called. */
  canUsePrivateApi: boolean;
}

interface VehicleChipProps {
  vehicle: Vehicle;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}

function VehicleChip({ vehicle, active, disabled, onPress }: VehicleChipProps) {
  const { colors } = useColorScheme();
  const Icon = VEHICLE_ICONS[vehicle.type];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || active}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Select ${vehicle.label ?? VEHICLE_LABELS[vehicle.type]}`}
      className={`flex-row items-center gap-2 rounded-full border px-4 py-2.5 ${
        active ? "border-primary bg-primary/10" : "border-border bg-background"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <Icon size={18} color={active ? colors.primary : colors.mutedForeground} />
      <Text
        className={`text-sm font-medium ${active ? "text-primary" : "text-foreground"}`}
      >
        {vehicle.label ?? VEHICLE_LABELS[vehicle.type]}
      </Text>
      {active ? <Check size={16} color={colors.primary} /> : null}
    </Pressable>
  );
}

export function VehicleSelector({ canUsePrivateApi }: VehicleSelectorProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { colors } = useColorScheme();

  const vehiclesQuery = useQuery({
    queryKey: queryKeys.courier.vehicles,
    queryFn: fetchCourierVehicles,
    enabled: canUsePrivateApi,
  });
  const courierQuery = useQuery({
    queryKey: queryKeys.courier.me,
    queryFn: fetchCourierMe,
    enabled: canUsePrivateApi,
  });

  const activeVehicleId = courierQuery.data?.data?.activeVehicleId;
  const vehicles = vehiclesQuery.data?.data ?? [];

  const setActiveMutation = useMutation({
    mutationFn: (vehicleId: string) => setActiveVehicle(vehicleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.courier.me });
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.courier });
    },
  });

  return (
    <Card>
      <CardContent className="gap-3 pt-5">
        <View className="flex-row items-center justify-between">
          <Text className="text-base font-semibold text-surface-foreground">
            Active vehicle
          </Text>
          <Pressable
            onPress={() => router.push("/vehicles")}
            accessibilityRole="button"
            accessibilityLabel="Manage vehicles"
            className="flex-row items-center gap-1 rounded-full px-2 py-1 active:bg-accent web:hover:bg-accent"
          >
            <Text className="text-sm font-medium text-primary">Manage</Text>
          </Pressable>
        </View>

        {!canUsePrivateApi || vehiclesQuery.isLoading || courierQuery.isLoading ? (
          <View className="py-4">
            <ActivityIndicator color={colors.mutedForeground} />
          </View>
        ) : vehicles.length === 0 ? (
          <Pressable
            onPress={() => router.push("/vehicles/new")}
            accessibilityRole="button"
            className="flex-row items-center gap-2 rounded-xl border border-dashed border-border px-4 py-3 active:bg-accent web:hover:bg-accent"
          >
            <Plus size={18} color={colors.primary} />
            <Text className="text-sm font-medium text-foreground">
              Add your first vehicle to start
            </Text>
          </Pressable>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2 pr-2"
          >
            {vehicles.map((vehicle) => (
              <VehicleChip
                key={vehicle.id}
                vehicle={vehicle}
                active={vehicle.id === activeVehicleId}
                disabled={setActiveMutation.isPending}
                onPress={() => setActiveMutation.mutate(vehicle.id)}
              />
            ))}
            <Pressable
              onPress={() => router.push("/vehicles/new")}
              accessibilityRole="button"
              accessibilityLabel="Add vehicle"
              className="flex-row items-center gap-2 rounded-full border border-dashed border-border px-4 py-2.5 active:bg-accent web:hover:bg-accent"
            >
              <Plus size={18} color={colors.mutedForeground} />
              <Text className="text-sm font-medium text-foreground">Add</Text>
            </Pressable>
          </ScrollView>
        )}
      </CardContent>
    </Card>
  );
}
