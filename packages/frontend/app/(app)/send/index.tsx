import { useMemo, useState } from 'react';
import { View, ScrollView, Pressable, Platform } from 'react-native';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useOxy } from '@oxyhq/services';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { EndpointPicker } from '@/components/transport/EndpointPicker';
import { useColorScheme } from '@/lib/useColorScheme';
import { useCreateShipment } from '@/lib/hooks/use-shipments';
import { SHIPMENT_TYPES, SHIPMENT_TYPE_ORDER } from '@/lib/shipment-type';
import {
  useShipmentDraft,
  isEndpointComplete,
  toCreateInput,
} from '@/lib/stores/shipment-draft-store';
import type { ShipmentType, SizeClass } from '@moovo/shared-types';

/** The wizard steps in order. */
const STEPS = ['type', 'pickup', 'dropoff', 'parcel'] as const;
type Step = (typeof STEPS)[number];

const SIZE_CLASSES: { value: SizeClass; label: string; hint: string }[] = [
  { value: 'small', label: 'Small', hint: 'Fits in a bag' },
  { value: 'medium', label: 'Medium', hint: 'A box or two' },
  { value: 'large', label: 'Large', hint: 'Furniture / bulky' },
];

/** The type-selection step. */
function TypeStep() {
  const { colors } = useColorScheme();
  const type = useShipmentDraft((s) => s.type);
  const setType = useShipmentDraft((s) => s.setType);
  return (
    <View className="gap-3">
      {SHIPMENT_TYPE_ORDER.map((t) => {
        const meta = SHIPMENT_TYPES[t];
        const Icon = meta.icon;
        const selected = type === t;
        return (
          <Pressable
            key={t}
            onPress={() => setType(t)}
            accessibilityRole="button"
            className={`flex-row items-center gap-3 rounded-2xl border bg-card p-4 active:opacity-80 ${selected ? 'border-primary' : 'border-border'}`}
          >
            <View className="h-11 w-11 items-center justify-center rounded-full bg-primary/10">
              <Icon size={22} color={colors.primary} />
            </View>
            <View className="flex-1">
              <Text className="text-base font-semibold text-foreground">{meta.label}</Text>
              <Text className="text-xs text-muted-foreground">{meta.description}</Text>
            </View>
            {selected ? (
              <View className="h-6 w-6 items-center justify-center rounded-full bg-primary">
                <Check size={14} color={colors.primaryForeground} />
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** The parcel + contents step (labels adapt to the chosen type). */
function ParcelStep() {
  const { colors } = useColorScheme();
  const type = useShipmentDraft((s) => s.type) ?? 'package';
  const parcel = useShipmentDraft((s) => s.parcel);
  const patchParcel = useShipmentDraft((s) => s.patchParcel);
  const itemDescription = useShipmentDraft((s) => s.itemDescription);
  const setItemDescription = useShipmentDraft((s) => s.setItemDescription);
  const meta = SHIPMENT_TYPES[type];

  return (
    <View className="gap-4">
      <View className="gap-2">
        <Text className="text-sm font-medium text-foreground">{meta.itemLabel}</Text>
        <Input
          value={itemDescription}
          onChangeText={setItemDescription}
          placeholder={meta.itemPrompt}
          multiline
        />
      </View>

      <View className="gap-2">
        <Text className="text-sm font-medium text-foreground">Size</Text>
        <View className="flex-row gap-2">
          {SIZE_CLASSES.map((sc) => {
            const selected = parcel.sizeClass === sc.value;
            return (
              <Pressable
                key={sc.value}
                onPress={() => patchParcel({ sizeClass: sc.value })}
                accessibilityRole="button"
                className={`flex-1 rounded-xl border bg-card p-3 active:opacity-80 ${selected ? 'border-primary' : 'border-border'}`}
              >
                <Text
                  className={`text-sm font-semibold ${selected ? 'text-primary' : 'text-foreground'}`}
                >
                  {sc.label}
                </Text>
                <Text className="mt-0.5 text-xs text-muted-foreground">{sc.hint}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View className="flex-row gap-2">
        <View className="flex-1 gap-2">
          <Text className="text-sm font-medium text-foreground">Weight (kg)</Text>
          <Input
            value={parcel.weightKg}
            onChangeText={(weightKg) => patchParcel({ weightKg })}
            placeholder="1"
            keyboardType="decimal-pad"
          />
        </View>
        <View className="flex-1 gap-2">
          <Text className="text-sm font-medium text-foreground">Pieces</Text>
          <Input
            value={parcel.pieces}
            onChangeText={(pieces) => patchParcel({ pieces })}
            placeholder="1"
            keyboardType="number-pad"
          />
        </View>
      </View>

      <View className="flex-row items-center justify-between rounded-xl border border-border bg-card p-4">
        <View className="flex-1 pr-3">
          <Text className="text-sm font-medium text-foreground">Fragile</Text>
          <Text className="text-xs text-muted-foreground">Handle with extra care</Text>
        </View>
        <Switch
          value={parcel.fragile}
          onValueChange={(fragile) => patchParcel({ fragile })}
        />
      </View>

      {/* `colors` referenced so the step reads theme without hardcoded values. */}
      <View className="h-px w-full" style={{ backgroundColor: colors.border }} />
    </View>
  );
}

export default function SendScreen() {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { isAuthenticated } = useOxy();
  const params = useLocalSearchParams<{ type?: string }>();

  const draft = useShipmentDraft();
  const createShipment = useCreateShipment();
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Preselect the type from the deep link the home CTA passes, and start on the
  // pickup step when it's pre-chosen. The lazy `useState` initializer runs ONCE
  // on mount; the zustand setter is called via the imperative store API
  // (`getState`) so no store write happens during render.
  const [step, setStep] = useState<Step>(() => {
    const presetType = SHIPMENT_TYPE_ORDER.find((t) => t === params.type) as
      | ShipmentType
      | undefined;
    if (presetType) {
      useShipmentDraft.getState().setType(presetType);
      return 'pickup';
    }
    return 'type';
  });
  const stepIndex = STEPS.indexOf(step);

  const canProceed = useMemo(() => {
    switch (step) {
      case 'type':
        return draft.type !== null;
      case 'pickup':
        return isEndpointComplete(draft.pickup);
      case 'dropoff':
        return isEndpointComplete(draft.dropoff);
      case 'parcel':
        return toCreateInput(draft) !== null;
    }
  }, [step, draft]);

  const stepTitle: Record<Step, string> = {
    type: 'What are you sending?',
    pickup: 'Pickup point',
    dropoff: 'Dropoff point',
    parcel: 'Details',
  };

  const handleBack = () => {
    setSubmitError(null);
    if (stepIndex === 0) {
      router.back();
      return;
    }
    setStep(STEPS[stepIndex - 1]);
  };

  const handleNext = async () => {
    setSubmitError(null);
    if (step !== 'parcel') {
      setStep(STEPS[stepIndex + 1]);
      return;
    }
    // Final step → submit.
    const input = toCreateInput(draft);
    if (!input) {
      setSubmitError('Please complete every required field before sending.');
      return;
    }
    try {
      const shipment = await createShipment.mutateAsync(input);
      draft.reset();
      router.replace(`/shipments/${shipment.id}/quotes`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not create your shipment.');
    }
  };

  // Defensive: the home CTA already gates on auth, but a deep link could land
  // an anonymous user here — send them home (the SDK owns the sign-in modal).
  if (!isAuthenticated) {
    return (
      <View className="flex-1 items-center justify-center bg-background px-8">
        <Text className="text-center text-base text-muted-foreground">
          Please sign in to create a shipment.
        </Text>
        <Pressable
          onPress={() => router.replace('/(app)')}
          className="mt-4 rounded-full bg-primary px-5 py-2.5 active:opacity-90"
        >
          <Text className="text-sm font-semibold text-primary-foreground">Back home</Text>
        </Pressable>
      </View>
    );
  }

  const isLast = step === 'parcel';

  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>Send · Moovo</title>
      </Head>

      {/* Header with progress. */}
      <View className="border-b border-border px-4 pb-3 pt-4">
        <View className="flex-row items-center gap-3">
          <Pressable onPress={handleBack} accessibilityRole="button" hitSlop={8} className="p-1">
            <ArrowLeft size={20} color={colors.foreground} />
          </Pressable>
          <Text className="flex-1 text-lg font-bold text-foreground">{stepTitle[step]}</Text>
          <Text className="text-xs text-muted-foreground">
            {stepIndex + 1} / {STEPS.length}
          </Text>
        </View>
        <View className="mt-3 h-1 flex-row gap-1">
          {STEPS.map((s, i) => (
            <View
              key={s}
              className={`h-1 flex-1 rounded-full ${i <= stepIndex ? 'bg-primary' : 'bg-border'}`}
            />
          ))}
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="px-4 py-4 pb-32"
        keyboardShouldPersistTaps="handled"
      >
        <View className="web:mx-auto web:w-full web:max-w-[640px]">
          {step === 'type' ? <TypeStep /> : null}
          {step === 'pickup' ? (
            <EndpointPicker kind="pickup" value={draft.pickup} onChange={draft.patchPickup} />
          ) : null}
          {step === 'dropoff' ? (
            <EndpointPicker kind="dropoff" value={draft.dropoff} onChange={draft.patchDropoff} />
          ) : null}
          {step === 'parcel' ? <ParcelStep /> : null}

          {submitError ? (
            <Text className="mt-4 text-center text-sm text-red-600">{submitError}</Text>
          ) : null}
        </View>
      </ScrollView>

      {/* Sticky action bar. */}
      <View
        className="border-t border-border bg-background px-4 py-3"
        style={Platform.OS !== 'web' ? { paddingBottom: 28 } : undefined}
      >
        <View className="web:mx-auto web:w-full web:max-w-[640px]">
          <Pressable
            onPress={handleNext}
            disabled={!canProceed || createShipment.isPending}
            accessibilityRole="button"
            className={`flex-row items-center justify-center gap-2 rounded-xl py-3.5 ${canProceed && !createShipment.isPending ? 'bg-primary active:opacity-90' : 'bg-muted'}`}
          >
            <Text
              className={`text-base font-semibold ${canProceed && !createShipment.isPending ? 'text-primary-foreground' : 'text-muted-foreground'}`}
            >
              {createShipment.isPending
                ? 'Creating…'
                : isLast
                  ? 'Get quotes'
                  : 'Continue'}
            </Text>
            {!isLast ? (
              <ArrowRight
                size={18}
                color={canProceed ? colors.primaryForeground : colors.mutedForeground}
              />
            ) : null}
          </Pressable>
        </View>
      </View>
    </View>
  );
}
