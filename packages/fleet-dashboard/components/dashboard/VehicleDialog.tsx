import { useState } from 'react';
import { View } from 'react-native';
import type { Vehicle, VehicleType, CreateVehicleInput } from '@moovo/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import type { UpdateVehicleBody } from '@/lib/api/vehicles';
import { useTranslation } from '@moovo/app-shell/hooks/useTranslation';

const VEHICLE_TYPES: VehicleType[] = ['bike', 'scooter', 'car', 'van', 'truck'];

/** Result emitted by the dialog — a create body or a partial update body. */
export interface VehicleDialogSubmit {
  create: CreateVehicleInput;
  update: UpdateVehicleBody;
}

interface VehicleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The vehicle being edited, or `null`/`undefined` when creating. */
  vehicle?: Vehicle | null;
  /** Whether the parent mutation is in flight. */
  loading: boolean;
  /** Submit the create body (when adding) or update body (when editing). */
  onCreate: (input: CreateVehicleInput) => void;
  onUpdate: (input: UpdateVehicleBody) => void;
}

/**
 * Add/edit a company vehicle. Type is required; label/plate and a weight
 * override are optional (the backend defaults capacity from the capability table
 * for the chosen type). When editing, the lifecycle status is also editable.
 */
export function VehicleDialog({
  open,
  onOpenChange,
  vehicle,
  loading,
  onCreate,
  onUpdate,
}: VehicleDialogProps) {
  const { t } = useTranslation();
  const isEdit = !!vehicle;

  const [type, setType] = useState<VehicleType>(vehicle?.type ?? 'car');
  const [label, setLabel] = useState(vehicle?.label ?? '');
  const [plate, setPlate] = useState(vehicle?.plate ?? '');
  const [weight, setWeight] = useState(
    vehicle?.capacity.maxWeightKg ? String(vehicle.capacity.maxWeightKg) : '',
  );
  const [active, setActive] = useState(vehicle ? vehicle.status === 'active' : true);

  const submit = () => {
    const trimmedLabel = label.trim();
    const trimmedPlate = plate.trim();
    const weightNum = Number.parseFloat(weight);
    const hasWeight = weight.trim().length > 0 && Number.isFinite(weightNum) && weightNum > 0;

    if (isEdit) {
      const update: UpdateVehicleBody = {
        type,
        status: active ? 'active' : 'inactive',
      };
      if (trimmedLabel) update.label = trimmedLabel;
      if (trimmedPlate) update.plate = trimmedPlate;
      if (hasWeight) update.capacity = { maxWeightKg: weightNum };
      onUpdate(update);
    } else {
      const create: CreateVehicleInput = { type };
      if (trimmedLabel) create.label = trimmedLabel;
      if (trimmedPlate) create.plate = trimmedPlate;
      if (hasWeight) create.capacity = { maxWeightKg: weightNum };
      onCreate(create);
    }
  };

  const types = VEHICLE_TYPES.map((vt) => ({ value: vt, label: t(`fleet.type.${vt}`) }));

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={isEdit ? t('fleet.editVehicle') : t('fleet.addVehicle')}
      footer={
        <View className="flex-row gap-2 p-5 pt-2">
          <Button
            appearance="outline"
            tone="neutral"
            className="flex-1"
            onPress={() => onOpenChange(false)}
            disabled={loading}
          >
            {t('common.cancel')}
          </Button>
          <Button className="flex-1" onPress={submit} loading={loading}>
            {isEdit ? t('common.save') : t('fleet.addVehicle')}
          </Button>
        </View>
      }
    >
      <View className="gap-4">
        <Field label={t('fleet.vehicleType')}>
          <Select value={type} onValueChange={(v) => setType(v as VehicleType)}>
            <SelectTrigger label={t('fleet.vehicleType')}>
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent
              label={t('fleet.vehicleType')}
              items={types}
              renderItem={(item) => (
                <SelectItem value={item.value} label={item.label}>
                  <SelectItemIndicator />
                  <SelectItemText>{item.label}</SelectItemText>
                </SelectItem>
              )}
            />
          </Select>
        </Field>

        <Field label={t('fleet.label')} description={t('fleet.labelHelper')}>
          <TextFieldInput
            label={t('fleet.label')}
            placeholder={t('fleet.labelPlaceholder')}
            value={label}
            onValueChange={setLabel}
            maxLength={120}
          />
        </Field>

        <Field label={t('fleet.plate')}>
          <TextFieldInput
            label={t('fleet.plate')}
            placeholder={t('fleet.platePlaceholder')}
            value={plate}
            onValueChange={setPlate}
            autoCapitalize="characters"
            maxLength={40}
          />
        </Field>

        <Field label={t('fleet.maxWeight')} description={t('fleet.maxWeightHelper')}>
          <TextFieldInput
            label={t('fleet.maxWeight')}
            placeholder="0"
            value={weight}
            onValueChange={setWeight}
            keyboardType="numeric"
          />
        </Field>

        {isEdit ? (
          <Field label={t('fleet.statusLabel')}>
            <SegmentedControl
              type="radio"
              value={active ? 'active' : 'inactive'}
              onValueChange={(v) => setActive(v === 'active')}
            >
              <SegmentedControlItem value="active">
                <SegmentedControlItemText>{t('fleet.statusActive')}</SegmentedControlItemText>
              </SegmentedControlItem>
              <SegmentedControlItem value="inactive">
                <SegmentedControlItemText>{t('fleet.statusInactive')}</SegmentedControlItemText>
              </SegmentedControlItem>
            </SegmentedControl>
          </Field>
        ) : null}
      </View>
    </Dialog>
  );
}
