import { useState } from "react";
import { View, ScrollView, Pressable, ActivityIndicator } from "react-native";
import Head from "expo-router/head";
import { useRouter } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useOxy } from "@oxyhq/services";
import type { CreateVehicleInput, VehicleType } from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { ScreenHeader } from "@/components/courier/ScreenHeader";
import { useColorScheme } from "@/lib/useColorScheme";
import { queryKeys } from "@/lib/hooks/query-keys";
import { createCourierVehicle } from "@/lib/api/courier";
import {
  VEHICLE_TYPES,
  VEHICLE_LABELS,
  VEHICLE_ICONS,
} from "@/components/courier/vehicle-meta";
import { errorMessage } from "@/lib/api/errors";

/** Parse a positive number from a text field, or `undefined` when blank/invalid. */
function parsePositive(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function NewVehicleForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { colors } = useColorScheme();

  const [type, setType] = useState<VehicleType>("bike");
  const [label, setLabel] = useState("");
  const [plate, setPlate] = useState("");
  const [maxWeight, setMaxWeight] = useState("");

  const createMutation = useMutation({
    mutationFn: (input: CreateVehicleInput) => createCourierVehicle(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.courier.vehicles });
      queryClient.invalidateQueries({ queryKey: queryKeys.courier.me });
      router.back();
    },
  });

  const handleSubmit = () => {
    const input: CreateVehicleInput = { type };
    const trimmedLabel = label.trim();
    const trimmedPlate = plate.trim();
    if (trimmedLabel.length > 0) input.label = trimmedLabel;
    if (trimmedPlate.length > 0) input.plate = trimmedPlate;
    const weight = parsePositive(maxWeight);
    if (weight !== undefined) input.capacity = { maxWeightKg: weight };
    createMutation.mutate(input);
  };

  return (
    <View className="gap-5 p-4">
      <View className="gap-2">
        <Text className="text-sm font-medium text-foreground">Type</Text>
        <View className="flex-row flex-wrap gap-2">
          {VEHICLE_TYPES.map((vehicleType) => {
            const Icon = VEHICLE_ICONS[vehicleType];
            const selected = vehicleType === type;
            return (
              <Pressable
                key={vehicleType}
                onPress={() => setType(vehicleType)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                className={`flex-row items-center gap-2 rounded-full border px-4 py-2.5 ${
                  selected ? "border-primary bg-primary/10" : "border-border bg-background"
                }`}
              >
                <Icon
                  size={18}
                  color={selected ? colors.primary : colors.mutedForeground}
                />
                <Text
                  className={`text-sm font-medium ${selected ? "text-primary" : "text-foreground"}`}
                >
                  {VEHICLE_LABELS[vehicleType]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View className="gap-2">
        <Text className="text-sm font-medium text-foreground">Label (optional)</Text>
        <Input
          value={label}
          onChangeText={setLabel}
          placeholder="e.g. Red Vespa"
          maxLength={120}
          autoCapitalize="words"
        />
      </View>

      <View className="gap-2">
        <Text className="text-sm font-medium text-foreground">Plate (optional)</Text>
        <Input
          value={plate}
          onChangeText={setPlate}
          placeholder="e.g. 1234 ABC"
          maxLength={40}
          autoCapitalize="characters"
        />
      </View>

      <View className="gap-2">
        <Text className="text-sm font-medium text-foreground">
          Max weight kg (optional)
        </Text>
        <Input
          value={maxWeight}
          onChangeText={setMaxWeight}
          placeholder="Defaults from vehicle type"
          keyboardType="numeric"
        />
        <Text className="text-xs text-muted-foreground">
          Leave blank to use the default capacity for the selected type. Eligible
          job types are computed automatically.
        </Text>
      </View>

      {createMutation.isError ? (
        <Card className="border-destructive">
          <CardContent className="pt-5">
            <Text className="text-sm text-destructive">
              {errorMessage(createMutation.error, "Could not create vehicle")}
            </Text>
          </CardContent>
        </Card>
      ) : null}

      <Button onPress={handleSubmit} disabled={createMutation.isPending} size="lg">
        {createMutation.isPending ? (
          <ActivityIndicator color={colors.primaryForeground} />
        ) : (
          <Text className="text-base font-semibold text-primary-foreground">
            Add vehicle
          </Text>
        )}
      </Button>
    </View>
  );
}

export default function NewVehicleScreen() {
  const { isAuthenticated, isAuthResolved } = useOxy();

  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>Add vehicle · Moovo Go</title>
      </Head>
      <ScreenHeader title="Add vehicle" />
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-24 mx-auto w-full max-w-2xl"
        keyboardShouldPersistTaps="handled"
      >
        {isAuthResolved && isAuthenticated ? (
          <NewVehicleForm />
        ) : (
          <Text className="p-8 text-center text-sm text-muted-foreground">
            Sign in to add a vehicle.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
