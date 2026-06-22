import { View, ScrollView, ActivityIndicator, Pressable } from "react-native";
import Head from "expo-router/head";
import { useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useOxy, showSignInModal } from "@oxyhq/services";
import type { Vehicle } from "@moovo/shared-types";
import { Plus, Check, Trash2 } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScreenHeader } from "@/components/courier/ScreenHeader";
import { useColorScheme } from "@/lib/useColorScheme";
import { queryKeys } from "@/lib/hooks/query-keys";
import {
  fetchCourierVehicles,
  fetchCourierMe,
  setActiveVehicle,
  deleteCourierVehicle,
} from "@/lib/api/courier";
import { VEHICLE_LABELS, VEHICLE_ICONS } from "@/components/courier/vehicle-meta";
import { errorMessage } from "@/lib/api/errors";

/** A single vehicle row with capability, active toggle, and delete. */
function VehicleRow({
  vehicle,
  active,
  busy,
  onSetActive,
  onDelete,
}: {
  vehicle: Vehicle;
  active: boolean;
  busy: boolean;
  onSetActive: () => void;
  onDelete: () => void;
}) {
  const { colors } = useColorScheme();
  const Icon = VEHICLE_ICONS[vehicle.type];

  return (
    <Card className={active ? "border-primary" : undefined}>
      <CardContent className="gap-3 pt-5">
        <View className="flex-row items-center gap-3">
          <View className="h-11 w-11 items-center justify-center rounded-full bg-primary/10">
            <Icon size={22} color={colors.primary} />
          </View>
          <View className="flex-1">
            <Text className="text-base font-semibold text-surface-foreground">
              {vehicle.label ?? VEHICLE_LABELS[vehicle.type]}
            </Text>
            <Text className="text-sm capitalize text-muted-foreground">
              {VEHICLE_LABELS[vehicle.type]}
              {vehicle.plate ? ` · ${vehicle.plate}` : ""}
            </Text>
          </View>
          {active ? (
            <View className="flex-row items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1">
              <Check size={14} color={colors.primary} />
              <Text className="text-xs font-semibold text-primary">Active</Text>
            </View>
          ) : null}
        </View>

        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-xs text-muted-foreground">
            Up to {vehicle.capacity.maxWeightKg} kg
          </Text>
          <Text className="text-xs text-muted-foreground">·</Text>
          <Text className="text-xs capitalize text-muted-foreground">
            {vehicle.eligibleJobTypes.join(", ") || "no job types"}
          </Text>
        </View>

        <View className="flex-row items-center justify-between gap-3 pt-1">
          {active ? (
            <View className="flex-1" />
          ) : (
            <Button
              variant="outline"
              size="sm"
              onPress={onSetActive}
              disabled={busy}
              className="flex-1"
            >
              <Text className="text-sm font-medium text-foreground">
                Set active
              </Text>
            </Button>
          )}
          <Pressable
            onPress={onDelete}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${vehicle.label ?? VEHICLE_LABELS[vehicle.type]}`}
            className="h-9 w-9 items-center justify-center rounded-lg active:bg-accent web:hover:bg-accent"
          >
            <Trash2 size={18} color={colors.mutedForeground} />
          </Pressable>
        </View>
      </CardContent>
    </Card>
  );
}

function VehiclesBody() {
  const { isAuthenticated, isAuthResolved, canUsePrivateApi } = useOxy();
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

  const setActiveMutation = useMutation({
    mutationFn: (vehicleId: string) => setActiveVehicle(vehicleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.courier.me });
      queryClient.invalidateQueries({ queryKey: queryKeys.jobs.courier });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (vehicleId: string) => deleteCourierVehicle(vehicleId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.courier.vehicles });
      queryClient.invalidateQueries({ queryKey: queryKeys.courier.me });
    },
  });

  if (!isAuthResolved) {
    return (
      <View className="items-center py-24">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }
  if (!isAuthenticated) {
    return (
      <View className="items-center gap-4 px-8 py-24">
        <Text className="text-center text-base text-muted-foreground">
          Sign in to manage your vehicles.
        </Text>
        <Button onPress={() => showSignInModal()}>
          <Text className="font-semibold text-primary-foreground">Sign in</Text>
        </Button>
      </View>
    );
  }

  const vehicles = vehiclesQuery.data?.data ?? [];
  const activeVehicleId = courierQuery.data?.data?.activeVehicleId;
  const busy = setActiveMutation.isPending || deleteMutation.isPending;

  return (
    <View className="gap-4 p-4">
      <Button onPress={() => router.push("/vehicles/new")} size="lg">
        <View className="flex-row items-center gap-2">
          <Plus size={18} color={colors.primaryForeground} />
          <Text className="text-base font-semibold text-primary-foreground">
            Add vehicle
          </Text>
        </View>
      </Button>

      {vehiclesQuery.isLoading || courierQuery.isLoading ? (
        <View className="items-center py-10">
          <ActivityIndicator color={colors.mutedForeground} />
        </View>
      ) : vehiclesQuery.isError ? (
        <Text className="py-10 text-center text-sm text-muted-foreground">
          {errorMessage(vehiclesQuery.error, "Could not load vehicles")}
        </Text>
      ) : vehicles.length === 0 ? (
        <Text className="py-10 text-center text-sm text-muted-foreground">
          No vehicles yet. Add one to start receiving jobs.
        </Text>
      ) : (
        <View className="gap-3">
          {vehicles.map((vehicle) => (
            <VehicleRow
              key={vehicle.id}
              vehicle={vehicle}
              active={vehicle.id === activeVehicleId}
              busy={busy}
              onSetActive={() => setActiveMutation.mutate(vehicle.id)}
              onDelete={() => deleteMutation.mutate(vehicle.id)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

export default function VehiclesScreen() {
  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>Vehicles · Moovo Go</title>
      </Head>
      <ScreenHeader title="Vehicles" subtitle="Manage what you drive" />
      <ScrollView className="flex-1" contentContainerClassName="pb-24 mx-auto w-full max-w-2xl">
        <VehiclesBody />
      </ScrollView>
    </View>
  );
}
