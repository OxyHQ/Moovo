import { useState } from "react";
import { View } from "react-native";
import type {
  Vehicle,
  VehicleType,
  CreateVehicleInput,
} from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Field } from "@/components/dashboard/FormScreen";
import type { UpdateVehicleBody } from "@/lib/api/vehicles";
import { useTranslation } from "@/hooks/useTranslation";

const VEHICLE_TYPES: VehicleType[] = ["bike", "scooter", "car", "van", "truck"];

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

  const [type, setType] = useState<VehicleType>(vehicle?.type ?? "car");
  const [label, setLabel] = useState(vehicle?.label ?? "");
  const [plate, setPlate] = useState(vehicle?.plate ?? "");
  const [weight, setWeight] = useState(
    vehicle?.capacity.maxWeightKg ? String(vehicle.capacity.maxWeightKg) : "",
  );
  const [active, setActive] = useState(
    vehicle ? vehicle.status === "active" : true,
  );

  const submit = () => {
    const trimmedLabel = label.trim();
    const trimmedPlate = plate.trim();
    const weightNum = Number.parseFloat(weight);
    const hasWeight = weight.trim().length > 0 && Number.isFinite(weightNum) && weightNum > 0;

    if (isEdit) {
      const update: UpdateVehicleBody = {
        type,
        status: active ? "active" : "inactive",
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeButton className="max-w-md gap-4">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("fleet.editVehicle") : t("fleet.addVehicle")}
          </DialogTitle>
        </DialogHeader>

        <Field label={t("fleet.vehicleType")}>
          <ToggleGroup
            type="single"
            value={type}
            onValueChange={(v) => {
              if (typeof v === "string" && v) setType(v as VehicleType);
            }}
          >
            <View className="flex-row flex-wrap gap-2">
              {VEHICLE_TYPES.map((vt) => (
                <ToggleGroupItem key={vt} value={vt} className="items-center">
                  {t(`fleet.type.${vt}`)}
                </ToggleGroupItem>
              ))}
            </View>
          </ToggleGroup>
        </Field>

        <Field label={t("fleet.label")} helper={t("fleet.labelHelper")}>
          <Input
            value={label}
            onChangeText={setLabel}
            placeholder={t("fleet.labelPlaceholder")}
            maxLength={120}
          />
        </Field>

        <Field label={t("fleet.plate")}>
          <Input
            value={plate}
            onChangeText={setPlate}
            placeholder={t("fleet.platePlaceholder")}
            autoCapitalize="characters"
            maxLength={40}
          />
        </Field>

        <Field label={t("fleet.maxWeight")} helper={t("fleet.maxWeightHelper")}>
          <Input
            value={weight}
            onChangeText={setWeight}
            placeholder="0"
            keyboardType="numeric"
          />
        </Field>

        {isEdit ? (
          <Field label={t("fleet.statusLabel")}>
            <ToggleGroup
              type="single"
              value={active ? "active" : "inactive"}
              onValueChange={(v) => {
                if (typeof v === "string" && v) setActive(v === "active");
              }}
            >
              <View className="flex-row gap-2">
                <ToggleGroupItem value="active" className="flex-1 items-center">
                  {t("fleet.statusActive")}
                </ToggleGroupItem>
                <ToggleGroupItem value="inactive" className="flex-1 items-center">
                  {t("fleet.statusInactive")}
                </ToggleGroupItem>
              </View>
            </ToggleGroup>
          </Field>
        ) : null}

        <DialogFooter className="mt-2 gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-9"
            onPress={() => onOpenChange(false)}
            disabled={loading}
          >
            <Text className="text-sm">{t("common.cancel")}</Text>
          </Button>
          <Button
            size="sm"
            className="flex-1 h-9"
            onPress={submit}
            isLoading={loading}
          >
            <Text className="text-sm text-primary-foreground">
              {isEdit ? t("common.save") : t("fleet.addVehicle")}
            </Text>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
