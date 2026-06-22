import { useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Truck } from "lucide-react-native";
import type {
  Vehicle,
  CreateVehicleInput,
  CompanyMember,
} from "@moovo/shared-types";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { DashboardScreen } from "@/components/dashboard/DashboardScreen";
import {
  CompanyHeader,
  NoCompaniesState,
  PermissionDenied,
} from "@/components/dashboard/CompanyHeader";
import { UserCell } from "@/components/dashboard/UserCell";
import { VehicleDialog } from "@/components/dashboard/VehicleDialog";
import { toast } from "@/components/sonner";
import {
  fetchVehicles,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  type UpdateVehicleBody,
} from "@/lib/api/vehicles";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useCompanyContext } from "@/lib/hooks/use-company-context";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";

/** Extract a human message from an axios/API error. */
function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "response" in err) {
    const data = (err as { response?: { data?: { message?: string; error?: string } } })
      .response?.data;
    if (data?.message) return data.message;
    if (data?.error) return data.error;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** One vehicle card with type, label/plate, eligible job types and status. */
function VehicleCard({
  vehicle,
  canWrite,
  onEdit,
  onDelete,
}: {
  vehicle: Vehicle;
  canWrite: boolean;
  onEdit: (v: Vehicle) => void;
  onDelete: (v: Vehicle) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const isActive = vehicle.status === "active";

  return (
    <Card className="min-w-0 flex-1 gap-3 p-4">
      <View className="flex-row items-center gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-primary/10">
          <Truck size={18} color={colors.primary} />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-semibold text-surface-foreground" numberOfLines={1}>
            {vehicle.label || t(`fleet.type.${vehicle.type}`)}
          </Text>
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {t(`fleet.type.${vehicle.type}`)}
            {vehicle.plate ? ` · ${vehicle.plate}` : ""}
          </Text>
        </View>
        <View
          className={cn(
            "self-start rounded-full px-2.5 py-1",
            isActive ? "bg-primary/10" : "bg-muted",
          )}
        >
          <Text
            className={cn(
              "text-xs font-semibold",
              isActive ? "text-primary" : "text-muted-foreground",
            )}
          >
            {isActive ? t("fleet.statusActive") : t("fleet.statusInactive")}
          </Text>
        </View>
      </View>

      <View className="flex-row flex-wrap gap-1.5">
        {vehicle.eligibleJobTypes.map((jt) => (
          <View key={jt} className="rounded-full bg-muted px-2 py-0.5">
            <Text className="text-[11px] font-medium text-muted-foreground">
              {t(`dispatch.type.${jt}`)}
            </Text>
          </View>
        ))}
        <Text className="text-[11px] text-muted-foreground">
          {t("fleet.capacityKg", { kg: vehicle.capacity.maxWeightKg })}
        </Text>
      </View>

      {canWrite ? (
        <View className="flex-row gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onPress={() => onEdit(vehicle)}
          >
            <View className="flex-row items-center gap-1.5">
              <Pencil size={14} color={colors.foreground} />
              <Text className="text-xs font-medium text-foreground">
                {t("common.edit")}
              </Text>
            </View>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onPress={() => onDelete(vehicle)}
            accessibilityLabel={t("common.delete")}
          >
            <Trash2 size={14} color={colors.mutedForeground} />
          </Button>
        </View>
      ) : null}
    </Card>
  );
}

/** The couriers enrolled in the fleet, derived from the company's members. */
function EnrolledCouriers({ members }: { members: CompanyMember[] }) {
  const { t } = useTranslation();
  // Drivers + dispatchers are the people who operate the fleet; owners are
  // operators too but listed under Members. Show the fleet-facing roles here.
  const couriers = members.filter(
    (m) => m.role === "driver" || m.role === "dispatcher",
  );

  return (
    <Card className="p-4">
      <Text className="pb-1 text-base font-semibold text-surface-foreground">
        {t("fleet.couriersTitle", { count: couriers.length })}
      </Text>
      {couriers.length === 0 ? (
        <Text className="py-6 text-center text-sm text-muted-foreground">
          {t("fleet.noCouriers")}
        </Text>
      ) : (
        couriers.map((m) => (
          <View key={m.oxyUserId} className="border-b border-border py-3">
            <UserCell
              oxyUserId={m.oxyUserId}
              subtitle={t(`members.role.${m.role}`)}
            />
          </View>
        ))
      )}
    </Card>
  );
}

function FleetBody() {
  const { t } = useTranslation();
  const ctx = useCompanyContext();
  const queryClient = useQueryClient();

  const companyId = ctx.selectedCompanyId;
  const canRead = ctx.can("jobs:read");
  const canWrite = ctx.can("fleet:write");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Vehicle | null>(null);
  const [toDelete, setToDelete] = useState<Vehicle | null>(null);

  const vehiclesQuery = useQuery({
    queryKey: companyId
      ? queryKeys.companies.vehicles(companyId)
      : ["companies", "none", "vehicles"],
    queryFn: () => fetchVehicles(companyId as string),
    enabled: ctx.canUsePrivateApi && companyId !== null && canRead,
  });

  const invalidate = () => {
    if (companyId) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.companies.vehicles(companyId),
      });
    }
  };

  const createMutation = useMutation({
    mutationFn: (input: CreateVehicleInput) =>
      createVehicle(companyId as string, input),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      toast.success(t("fleet.vehicleAdded"));
    },
    onError: (err) => toast.error(errorMessage(err, t("fleet.addFailed"))),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateVehicleBody }) =>
      updateVehicle(companyId as string, id, input),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      setEditing(null);
      toast.success(t("fleet.vehicleUpdated"));
    },
    onError: (err) => toast.error(errorMessage(err, t("fleet.updateFailed"))),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteVehicle(companyId as string, id),
    onSuccess: () => {
      invalidate();
      toast.success(t("fleet.vehicleDeleted"));
    },
    onError: (err) => toast.error(errorMessage(err, t("fleet.deleteFailed"))),
  });

  if (ctx.isLoadingCompanies) {
    return (
      <View className="items-center py-16">
        <ActivityIndicator />
      </View>
    );
  }
  if (ctx.companies.length === 0) return <NoCompaniesState />;

  const company = ctx.company;
  const vehicles = vehiclesQuery.data ?? [];

  return (
    <View className="gap-6 px-5 py-8 md:px-8">
      <CompanyHeader
        title={t("nav.fleet")}
        companies={ctx.companies}
        selectedCompanyId={ctx.selectedCompanyId}
        onSelect={ctx.selectCompany}
        action={
          canWrite ? (
            <Button
              size="sm"
              onPress={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <View className="flex-row items-center gap-1.5">
                <Plus size={16} className="text-primary-foreground" />
                <Text className="text-sm font-medium text-primary-foreground">
                  {t("fleet.addVehicle")}
                </Text>
              </View>
            </Button>
          ) : undefined
        }
      />

      {!canRead ? (
        <PermissionDenied message={t("fleet.readDenied")} />
      ) : (
        <>
          {vehiclesQuery.isPending ? (
            <View className="items-center py-16">
              <ActivityIndicator />
            </View>
          ) : vehiclesQuery.isError ? (
            <View className="items-center gap-3 py-16">
              <Text className="text-center text-sm text-muted-foreground">
                {t("fleet.loadError")}
              </Text>
              <Button variant="outline" onPress={() => vehiclesQuery.refetch()}>
                <Text className="text-sm font-medium text-foreground">
                  {t("common.tryAgain")}
                </Text>
              </Button>
            </View>
          ) : vehicles.length === 0 ? (
            <Card className="items-center gap-2 p-8">
              <Text className="text-center text-sm text-muted-foreground">
                {t("fleet.noVehicles")}
              </Text>
            </Card>
          ) : (
            <View className="gap-3 md:flex-row md:flex-wrap">
              {vehicles.map((v) => (
                <View key={v.id} className="md:w-[calc(50%-6px)] lg:w-[calc(33.333%-8px)]">
                  <VehicleCard
                    vehicle={v}
                    canWrite={canWrite}
                    onEdit={(veh) => {
                      setEditing(veh);
                      setDialogOpen(true);
                    }}
                    onDelete={setToDelete}
                  />
                </View>
              ))}
            </View>
          )}

          {company ? <EnrolledCouriers members={company.members} /> : null}
        </>
      )}

      <VehicleDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
        vehicle={editing}
        loading={createMutation.isPending || updateMutation.isPending}
        onCreate={(input) => createMutation.mutate(input)}
        onUpdate={(input) => {
          if (editing) updateMutation.mutate({ id: editing.id, input });
        }}
      />

      <ConfirmationDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title={t("fleet.deleteTitle")}
        description={t("fleet.deleteConfirm")}
        confirmText={t("common.delete")}
        confirmVariant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={() => {
          if (toDelete) deleteMutation.mutate(toDelete.id);
        }}
      />
    </View>
  );
}

export default function FleetScreen() {
  return (
    <DashboardScreen title="Fleet · Moovo Hub">
      <FleetBody />
    </DashboardScreen>
  );
}
