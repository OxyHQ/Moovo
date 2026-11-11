import { View, ScrollView, Pressable } from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';
import Head from 'expo-router/head';
import { useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import type { Vehicle } from '@moovo/shared-types';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useTheme } from '@oxy.so/bloom/theme';
import { queryKeys } from '@/lib/hooks/query-keys';
import {
  fetchCourierVehicles,
  fetchCourierMe,
  setActiveVehicle,
  deleteCourierVehicle,
} from '@/lib/api/courier';
import { VEHICLE_LABELS, VEHICLE_ICONS } from '@/components/courier/vehicle-meta';
import { errorMessage } from '@/lib/api/errors';

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
  const { colors } = useTheme();
  const Icon = VEHICLE_ICONS[vehicle.type];

  return (
    <Card className={active ? 'gap-3 border-primary p-4' : 'gap-3 p-4'}>
      <View className="flex-row items-center gap-3">
        <View className="h-11 w-11 items-center justify-center rounded-full bg-primary/10">
          <Icon width={22} fill={colors.primary} />
        </View>
        <View className="flex-1">
          <Text className="text-base font-semibold text-surface-foreground">
            {vehicle.label ?? VEHICLE_LABELS[vehicle.type]}
          </Text>
          <Text className="text-sm capitalize text-muted-foreground">
            {VEHICLE_LABELS[vehicle.type]}
            {vehicle.plate ? ` · ${vehicle.plate}` : ''}
          </Text>
        </View>
        {active ? (
          <View className="flex-row items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1">
            <RiCheckLine width={14} height={14} fill={colors.primary} />
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
          {vehicle.eligibleJobTypes.join(', ') || 'no job types'}
        </Text>
      </View>

      <View className="flex-row items-center justify-between gap-3 pt-1">
        {active ? (
          <View className="flex-1" />
        ) : (
          <Button
            appearance="outline"
            tone="neutral"
            size="sm"
            className="flex-1"
            onPress={onSetActive}
            disabled={busy}
          >
            Set active
          </Button>
        )}
        <Pressable
          onPress={onDelete}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${vehicle.label ?? VEHICLE_LABELS[vehicle.type]}`}
          className="h-9 w-9 items-center justify-center rounded-lg active:bg-accent web:hover:bg-accent"
        >
          <RiDeleteBinLine width={18} height={18} fill={colors.textSecondary} />
        </Pressable>
      </View>
    </Card>
  );
}

function VehiclesBody() {
  const { isAuthenticated, isAuthResolved, canUsePrivateApi, openAccountDialog } = useOxy();
  const router = useRouter();
  const queryClient = useQueryClient();

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
        <Loading variant="spinner" size="sm" />
      </View>
    );
  }
  if (!isAuthenticated) {
    return (
      <View className="items-center gap-4 px-8 py-24">
        <Text className="text-center text-base text-muted-foreground">
          Sign in to manage your vehicles.
        </Text>
        <Button onPress={() => openAccountDialog()}>Sign in</Button>
      </View>
    );
  }

  const vehicles = vehiclesQuery.data?.data ?? [];
  const activeVehicleId = courierQuery.data?.data?.activeVehicleId;
  const busy = setActiveMutation.isPending || deleteMutation.isPending;

  return (
    <View className="gap-4 p-4">
      <Button size="lg" onPress={() => router.push('/vehicles/new')} leadingIcon={RiAddLine}>
        Add vehicle
      </Button>

      {vehiclesQuery.isLoading || courierQuery.isLoading ? (
        <View className="items-center py-10">
          <Loading variant="spinner" size="sm" />
        </View>
      ) : vehiclesQuery.isError ? (
        <Text className="py-10 text-center text-sm text-muted-foreground">
          {errorMessage(vehiclesQuery.error, 'Could not load vehicles')}
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
  const router = useRouter();
  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>Vehicles · Moovo Go</title>
      </Head>
      <PageHeader
        presentation="bar"
        title="Vehicles"
        subtitle="Manage what you drive"
        onBack={() => router.back()}
      />
      <ScrollView className="flex-1" contentContainerClassName="pb-24 mx-auto w-full max-w-2xl">
        <VehiclesBody />
      </ScrollView>
    </View>
  );
}
