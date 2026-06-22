/**
 * Provider model — a registered external delivery carrier (e.g. DHL, FedEx).
 *
 * Data-driven: each doc declares which shipment types and countries it serves
 * plus opaque, NON-secret adapter `config` (a `Mixed` map). Credentials/secrets
 * are NEVER stored here — they come from the runtime environment / secret store.
 * `key` matches the registered `ProviderAdapter.key` so the quote service can
 * look up the adapter for an enabled provider.
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { ShipmentType } from '@moovo/shared-types';

const SHIPMENT_TYPES: readonly ShipmentType[] = ['package', 'food', 'move'];

export interface IProvider {
  _id: mongoose.Types.ObjectId;
  key: string;
  name: string;
  logoFileId?: string;
  enabled: boolean;
  supportedTypes: ShipmentType[];
  supportedCountries: string[];
  config?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const ProviderSchema = new Schema<IProvider>(
  {
    key: { type: String, required: true },
    name: { type: String, required: true },
    logoFileId: { type: String },
    enabled: { type: Boolean, default: true },
    supportedTypes: { type: [String], enum: SHIPMENT_TYPES as string[], default: [] },
    supportedCountries: { type: [String], default: [] },
    config: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

ProviderSchema.index({ key: 1 }, { unique: true });
ProviderSchema.index({ enabled: 1 });

export const Provider: Model<IProvider> =
  mongoose.models.Provider || mongoose.model<IProvider>('Provider', ProviderSchema);
