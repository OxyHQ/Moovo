import {
  Bike,
  type LucideIcon,
  Truck,
  Car,
  Package,
} from "lucide-react-native";
import type { VehicleType } from "@moovo/shared-types";

/**
 * Presentation metadata for the courier vehicle types (PURE — no I/O).
 *
 * The capability envelope (`eligibleJobTypes`, max weight/size) is derived
 * SERVER-SIDE from the vehicle `type`; this module only maps a type to its
 * display label + icon for the vehicle selector and vehicle list.
 */

/** All selectable vehicle types in display order. */
export const VEHICLE_TYPES: readonly VehicleType[] = [
  "bike",
  "scooter",
  "car",
  "van",
  "truck",
] as const;

/** Human label for each vehicle type. */
export const VEHICLE_LABELS: Record<VehicleType, string> = {
  bike: "Bike",
  scooter: "Scooter",
  car: "Car",
  van: "Van",
  truck: "Truck",
};

/** Icon for each vehicle type (lucide). */
export const VEHICLE_ICONS: Record<VehicleType, LucideIcon> = {
  bike: Bike,
  scooter: Bike,
  car: Car,
  van: Truck,
  truck: Truck,
};

/** Fallback icon when a job type / vehicle is unknown. */
export const FALLBACK_VEHICLE_ICON: LucideIcon = Package;
