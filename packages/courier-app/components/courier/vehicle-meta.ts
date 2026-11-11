import { RiBikeLine } from '@oxy.so/bloom/icons/RiBikeLine';
import { RiBox3Line } from '@oxy.so/bloom/icons/RiBox3Line';
import { RiCarLine } from '@oxy.so/bloom/icons/RiCarLine';
import { RiTruckLine } from '@oxy.so/bloom/icons/RiTruckLine';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import type { VehicleType } from '@moovo/shared-types';

/**
 * Presentation metadata for the courier vehicle types (PURE — no I/O).
 *
 * The capability envelope (`eligibleJobTypes`, max weight/size) is derived
 * SERVER-SIDE from the vehicle `type`; this module only maps a type to its
 * display label + icon for the vehicle selector and vehicle list.
 */

/** All selectable vehicle types in display order. */
export const VEHICLE_TYPES: readonly VehicleType[] = [
  'bike',
  'scooter',
  'car',
  'van',
  'truck',
] as const;

/** Human label for each vehicle type. */
export const VEHICLE_LABELS: Record<VehicleType, string> = {
  bike: 'Bike',
  scooter: 'Scooter',
  car: 'Car',
  van: 'Van',
  truck: 'Truck',
};

/** Icon for each vehicle type. */
export const VEHICLE_ICONS: Record<VehicleType, BloomIconComponent> = {
  bike: RiBikeLine,
  scooter: RiBikeLine,
  car: RiCarLine,
  van: RiTruckLine,
  truck: RiTruckLine,
};

/** Fallback icon when a job type / vehicle is unknown. */
export const FALLBACK_VEHICLE_ICON: BloomIconComponent = RiBox3Line;
