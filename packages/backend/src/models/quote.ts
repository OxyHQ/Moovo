/**
 * Quote model — a priced fulfilment option for a shipment (child collection).
 *
 * Either an internal Moovo-courier quote (`source: 'moovo_courier'`, priced by
 * `pricing.service`) or an external-provider quote (`source: 'external_provider'`,
 * returned by a provider adapter). Every price component is a FAIR
 * {@link FairMoneySchema} sub-doc — FAIR (`currency: 'FAIR'`) is the stored source
 * of truth. `expiresAt` carries a TTL index so lapsed quotes are reaped
 * automatically. `shipmentId`/`providerId` are ALWAYS Strings (never refs).
 */

import mongoose, { Schema, Model } from 'mongoose';
import type { FairMoney, QuoteSource, QuoteStatus } from '@moovo/shared-types';
import { FAIR_CURRENCY } from '@moovo/shared-types';
import { FairMoneySchema } from './schemas/fair-money-schema.js';

const QUOTE_SOURCES: readonly QuoteSource[] = ['moovo_courier', 'external_provider'];
const QUOTE_STATUSES: readonly QuoteStatus[] = ['active', 'selected', 'expired'];

export interface IPriceBreakdown {
  base: FairMoney;
  distance: FairMoney;
  size: FairMoney;
  surge?: FairMoney;
  fees?: FairMoney;
  total: FairMoney;
}

export interface IQuote {
  _id: mongoose.Types.ObjectId;
  shipmentId: string;
  source: QuoteSource;
  providerId?: string;
  providerQuoteRef?: string;
  priceBreakdown: IPriceBreakdown;
  currency: typeof FAIR_CURRENCY;
  etaPickupMin?: number;
  etaDeliveryMin?: number;
  expiresAt: Date;
  status: QuoteStatus;
  createdAt: Date;
  updatedAt: Date;
}

const PriceBreakdownSchema = new Schema<IPriceBreakdown>(
  {
    base: { type: FairMoneySchema, required: true },
    distance: { type: FairMoneySchema, required: true },
    size: { type: FairMoneySchema, required: true },
    surge: { type: FairMoneySchema },
    fees: { type: FairMoneySchema },
    total: { type: FairMoneySchema, required: true },
  },
  { _id: false },
);

const QuoteSchema = new Schema<IQuote>(
  {
    shipmentId: { type: String, required: true },
    source: { type: String, enum: QUOTE_SOURCES as string[], required: true },
    providerId: { type: String },
    providerQuoteRef: { type: String },
    priceBreakdown: { type: PriceBreakdownSchema, required: true },
    currency: { type: String, enum: [FAIR_CURRENCY], default: FAIR_CURRENCY },
    etaPickupMin: { type: Number },
    etaDeliveryMin: { type: Number },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: QUOTE_STATUSES as string[], default: 'active' },
  },
  { timestamps: true },
);

QuoteSchema.index({ shipmentId: 1, status: 1 });
// TTL index: a quote is reaped once `expiresAt` is in the past.
QuoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Quote: Model<IQuote> =
  mongoose.models.Quote || mongoose.model<IQuote>('Quote', QuoteSchema);
