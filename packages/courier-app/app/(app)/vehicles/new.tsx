import { useState } from 'react';
import { View, ScrollView } from 'react-native';
import Head from 'expo-router/head';
import { useRouter } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import type { CreateVehicleInput, VehicleType } from '@moovo/shared-types';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { Chip, ChipRow } from '@oxy.so/bloom/chip';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Card } from '@oxy.so/bloom/card';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { queryKeys } from '@/lib/hooks/query-keys';
import { createCourierVehicle } from '@/lib/api/courier';
import { VEHICLE_TYPES, VEHICLE_LABELS, VEHICLE_ICONS } from '@/components/courier/vehicle-meta';
import { errorMessage } from '@/lib/api/errors';

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

  const [type, setType] = useState<VehicleType>('bike');
  const [label, setLabel] = useState('');
  const [plate, setPlate] = useState('');
  const [maxWeight, setMaxWeight] = useState('');

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
      <Field label="Type" multiple>
        <ChipRow role="radiogroup" accessibilityLabel="Type">
          {VEHICLE_TYPES.map((vehicleType) => (
            <Chip
              key={vehicleType}
              size="xl"
              role="radio"
              leadingIcon={VEHICLE_ICONS[vehicleType]}
              selected={vehicleType === type}
              onPress={() => setType(vehicleType)}
            >
              {VEHICLE_LABELS[vehicleType]}
            </Chip>
          ))}
        </ChipRow>
      </Field>

      <TextFieldInput
        label="Label (optional)"
        placeholder="e.g. Red Vespa"
        value={label}
        onValueChange={setLabel}
        maxLength={120}
        autoCapitalize="words"
      />

      <TextFieldInput
        label="Plate (optional)"
        placeholder="e.g. 1234 ABC"
        value={plate}
        onValueChange={setPlate}
        maxLength={40}
        autoCapitalize="characters"
      />

      <Field
        label="Max weight kg (optional)"
        description="Leave blank to use the default capacity for the selected type. Eligible job types are computed automatically."
      >
        <TextFieldInput
          label="Max weight kg (optional)"
          placeholder="Defaults from vehicle type"
          value={maxWeight}
          onValueChange={setMaxWeight}
          keyboardType="numeric"
        />
      </Field>

      {createMutation.isError ? (
        <Card className="border-destructive p-4">
          <Text className="text-sm text-destructive">
            {errorMessage(createMutation.error, 'Could not create vehicle')}
          </Text>
        </Card>
      ) : null}

      <Button size="lg" onPress={handleSubmit} loading={createMutation.isPending}>
        Add vehicle
      </Button>
    </View>
  );
}

export default function NewVehicleScreen() {
  const router = useRouter();
  const { isAuthenticated, isAuthResolved } = useOxy();

  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>Add vehicle · Moovo Go</title>
      </Head>
      <PageHeader presentation="bar" title="Add vehicle" onBack={() => router.back()} />
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
