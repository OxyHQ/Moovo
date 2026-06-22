/**
 * Reusable embedded FAIR money sub-schema.
 *
 * `FairMoney.fairMinor` (integer FAIR minor units) is the persisted SOURCE OF
 * TRUTH for every Moovo transport price; `originalCurrency`/`originalAmount` are
 * an optional audit trail of what the user originally entered. This sub-document
 * is embedded (no own `_id`) wherever a model stores a FAIR amount (quote price
 * breakdown, job totals/quote snapshot) so the persisted shape matches the
 * `FairMoney` DTO exactly.
 */

import { Schema } from 'mongoose';
import type { FairMoney, SupportedCurrency } from '@moovo/shared-types';

const SUPPORTED_CURRENCIES: readonly SupportedCurrency[] = ['FAIR', 'EUR', 'USD'];

/** Embedded `{ fairMinor, originalCurrency?, originalAmount? }` sub-schema. */
export const FairMoneySchema = new Schema<FairMoney>(
  {
    fairMinor: { type: Number, required: true },
    originalCurrency: { type: String, enum: SUPPORTED_CURRENCIES as string[] },
    originalAmount: { type: Number },
  },
  { _id: false },
);
