import { useMemo, useState } from 'react';
import { View, ScrollView, Platform } from 'react-native';
import Head from 'expo-router/head';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services/ui/client';
import { RiArrowRightLine } from '@oxy.so/bloom/icons/RiArrowRightLine';
import { Button } from '@oxy.so/bloom/button';
import { SelectionCard } from '@oxy.so/bloom/card';
import { Field } from '@oxy.so/bloom/field';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Switch } from '@oxy.so/bloom/switch';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Text } from '@oxy.so/bloom/typography';
import { EndpointPicker } from '@/components/transport/EndpointPicker';
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
  const type = useShipmentDraft((s) => s.type);
  const setType = useShipmentDraft((s) => s.setType);
  return (
    <Field label="What are you sending?" multiple>
      <View className="gap-3">
        {SHIPMENT_TYPE_ORDER.map((t) => {
          const meta = SHIPMENT_TYPES[t];
          return (
            <SelectionCard
              key={t}
              selection="single"
              icon={meta.icon}
              title={meta.label}
              description={meta.description}
              selected={type === t}
              onPress={() => setType(t)}
            />
          );
        })}
      </View>
    </Field>
  );
}

/** The parcel + contents step (labels adapt to the chosen type). */
function ParcelStep() {
  const type = useShipmentDraft((s) => s.type) ?? 'package';
  const parcel = useShipmentDraft((s) => s.parcel);
  const patchParcel = useShipmentDraft((s) => s.patchParcel);
  const itemDescription = useShipmentDraft((s) => s.itemDescription);
  const setItemDescription = useShipmentDraft((s) => s.setItemDescription);
  const meta = SHIPMENT_TYPES[type];

  return (
    <View className="gap-4">
      <TextFieldInput
        label={meta.itemLabel}
        value={itemDescription}
        onValueChange={setItemDescription}
        placeholder={meta.itemPrompt}
        multiline
      />

      <Field label="Size" multiple>
        <View className="flex-row gap-2">
          {SIZE_CLASSES.map((sc) => (
            <View key={sc.value} className="flex-1">
              <SelectionCard
                selection="single"
                compact
                title={sc.label}
                description={sc.hint}
                selected={parcel.sizeClass === sc.value}
                onPress={() => patchParcel({ sizeClass: sc.value })}
              />
            </View>
          ))}
        </View>
      </Field>

      <View className="flex-row gap-2">
        <View className="flex-1">
          <TextFieldInput
            label="Weight (kg)"
            value={parcel.weightKg}
            onValueChange={(weightKg) => patchParcel({ weightKg })}
            placeholder="1"
            keyboardType="decimal-pad"
          />
        </View>
        <View className="flex-1">
          <TextFieldInput
            label="Pieces"
            value={parcel.pieces}
            onValueChange={(pieces) => patchParcel({ pieces })}
            placeholder="1"
            keyboardType="number-pad"
          />
        </View>
      </View>

      <Field label="Fragile" description="Handle with extra care">
        <Switch checked={parcel.fragile} onCheckedChange={(fragile) => patchParcel({ fragile })} />
      </Field>
    </View>
  );
}

export default function SendScreen() {
  const router = useRouter();
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
        <Button className="mt-4" onPress={() => router.replace('/(app)')}>
          Back home
        </Button>
      </View>
    );
  }

  const isLast = step === 'parcel';

  return (
    <View className="flex-1 bg-background">
      <Head>
        <title>Send · Moovo</title>
      </Head>

      <PageHeader
        presentation="bar"
        title={stepTitle[step]}
        subtitle={`${stepIndex + 1} / ${STEPS.length}`}
        onBack={handleBack}
      />
      <View className="h-1 flex-row gap-1 px-4">
        {STEPS.map((s, i) => (
          <View
            key={s}
            className={`h-1 flex-1 rounded-full ${i <= stepIndex ? 'bg-primary' : 'bg-border'}`}
          />
        ))}
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
          <Button
            size="lg"
            onPress={handleNext}
            disabled={!canProceed}
            loading={createShipment.isPending}
            trailingIcon={isLast ? undefined : RiArrowRightLine}
          >
            {isLast ? 'Get quotes' : 'Continue'}
          </Button>
        </View>
      </View>
    </View>
  );
}
