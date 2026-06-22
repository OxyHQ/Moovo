import { create } from 'zustand';
import type {
  ShipmentType,
  ShipmentEndpoint,
  ShipmentAddress,
  ParcelDetails,
  SizeClass,
  Scheduling,
  CreateShipmentInput,
} from '@moovo/shared-types';
import type { Coordinates } from '@/lib/hooks/use-location';

/**
 * In-memory draft store for the multi-step create-shipment flow.
 *
 * The flow (type → pickup/dropoff → parcel/contents → submit) accumulates a
 * partial draft here so each step is a thin screen reading/patching one slice. On
 * submit, `toCreateInput()` validates the draft is complete and produces the
 * `CreateShipmentInput` POST body; `reset()` clears it after a successful create
 * or when the user abandons the flow. This is ephemeral UI state (not persisted)
 * — a fresh send always starts clean.
 */

/** A partially-filled endpoint while the user is mid-flow. */
export interface DraftEndpoint {
  coordinate?: Coordinates;
  address: Partial<ShipmentAddress>;
  contactName: string;
  contactPhone: string;
  notes: string;
}

/** A partially-filled parcel while the user is mid-flow. */
export interface DraftParcel {
  weightKg: string;
  sizeClass: SizeClass;
  pieces: string;
  fragile: boolean;
}

interface ShipmentDraftState {
  type: ShipmentType | null;
  pickup: DraftEndpoint;
  dropoff: DraftEndpoint;
  parcel: DraftParcel;
  itemDescription: string;
  scheduling: Scheduling;

  setType: (type: ShipmentType) => void;
  patchPickup: (patch: Partial<DraftEndpoint>) => void;
  patchDropoff: (patch: Partial<DraftEndpoint>) => void;
  patchParcel: (patch: Partial<DraftParcel>) => void;
  setItemDescription: (value: string) => void;
  setScheduling: (scheduling: Scheduling) => void;
  reset: () => void;
}

/** A blank endpoint. */
function emptyEndpoint(): DraftEndpoint {
  return { address: {}, contactName: '', contactPhone: '', notes: '' };
}

/** A blank parcel (sensible defaults: 1kg, small, single piece). */
function emptyParcel(): DraftParcel {
  return { weightKg: '1', sizeClass: 'small', pieces: '1', fragile: false };
}

const INITIAL = {
  type: null as ShipmentType | null,
  pickup: emptyEndpoint(),
  dropoff: emptyEndpoint(),
  parcel: emptyParcel(),
  itemDescription: '',
  scheduling: { kind: 'now' } as Scheduling,
};

export const useShipmentDraft = create<ShipmentDraftState>((set) => ({
  ...INITIAL,
  setType: (type) => set({ type }),
  patchPickup: (patch) => set((s) => ({ pickup: { ...s.pickup, ...patch } })),
  patchDropoff: (patch) => set((s) => ({ dropoff: { ...s.dropoff, ...patch } })),
  patchParcel: (patch) => set((s) => ({ parcel: { ...s.parcel, ...patch } })),
  setItemDescription: (itemDescription) => set({ itemDescription }),
  setScheduling: (scheduling) => set({ scheduling }),
  reset: () =>
    set({
      type: null,
      pickup: emptyEndpoint(),
      dropoff: emptyEndpoint(),
      parcel: emptyParcel(),
      itemDescription: '',
      scheduling: { kind: 'now' },
    }),
}));

/** Whether a draft endpoint has the minimum fields to proceed. */
export function isEndpointComplete(e: DraftEndpoint): boolean {
  return Boolean(
    e.coordinate &&
      e.address.line1 &&
      e.address.city &&
      e.address.postalCode &&
      e.address.country &&
      e.contactName.trim() &&
      e.contactPhone.trim(),
  );
}

/** Convert a complete draft endpoint into a `ShipmentEndpoint`, or `null`. */
function toEndpoint(e: DraftEndpoint): ShipmentEndpoint | null {
  if (!isEndpointComplete(e) || !e.coordinate) {
    return null;
  }
  const endpoint: ShipmentEndpoint = {
    location: { type: 'Point', coordinates: e.coordinate },
    address: {
      line1: e.address.line1 ?? '',
      city: e.address.city ?? '',
      postalCode: e.address.postalCode ?? '',
      country: e.address.country ?? '',
    },
    contactName: e.contactName.trim(),
    contactPhone: e.contactPhone.trim(),
  };
  if (e.address.line2) endpoint.address.line2 = e.address.line2;
  if (e.address.region) endpoint.address.region = e.address.region;
  if (e.notes.trim()) endpoint.notes = e.notes.trim();
  return endpoint;
}

/** Convert a draft parcel into `ParcelDetails`, or `null` when invalid. */
function toParcel(p: DraftParcel): ParcelDetails | null {
  const weightKg = Number.parseFloat(p.weightKg);
  const pieces = Number.parseInt(p.pieces, 10);
  if (!Number.isFinite(weightKg) || weightKg < 0 || !Number.isInteger(pieces) || pieces < 1) {
    return null;
  }
  return { weightKg, sizeClass: p.sizeClass, pieces, fragile: p.fragile };
}

/**
 * Build the `CreateShipmentInput` from a complete draft, or `null` when the
 * draft is missing required fields (the screen keeps the user on the flow).
 */
export function toCreateInput(state: ShipmentDraftState): CreateShipmentInput | null {
  if (!state.type) {
    return null;
  }
  const pickup = toEndpoint(state.pickup);
  const dropoff = toEndpoint(state.dropoff);
  const parcel = toParcel(state.parcel);
  if (!pickup || !dropoff || !parcel) {
    return null;
  }
  return {
    type: state.type,
    pickup,
    dropoff,
    parcel,
    itemDescription: state.itemDescription.trim(),
    scheduling: state.scheduling,
  };
}
