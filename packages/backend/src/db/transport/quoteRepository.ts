/**
 * Every statement this service issues against `quotes`, and the one guard that
 * keeps the table's price breakdown honest.
 *
 * ## The audit trail is stored per BREAKDOWN, not per component
 *
 * `FairMoney` carries an optional `{originalCurrency, originalAmount}` audit
 * pair, and `PriceBreakdown` has SIX of them — one per component. `quotes`
 * stores six `*_fair_minor` columns but only ONE `original_currency` and ONE
 * `original_amount`, so the table is deliberately less expressive than the
 * type.
 *
 * That is lossless today, and the measurement is the whole justification:
 * `pricing.service.ts` and `mock-provider.ts` are the only producers, both
 * build every component through a one-line `fair()` helper returning
 * `{fairMinor, originalCurrency: 'FAIR'}`, and NOTHING in the repository sets
 * `originalAmount` at all. Six columns for one value repeated six times would
 * be storage for a distinction no writer makes.
 *
 * It stops being lossless the day an adapter quotes in a non-FAIR currency —
 * at which point the honest fix is six pairs and a migration, NOT picking
 * whichever component the reader happened to look at. So the collapse is
 * GUARDED rather than documented: {@link collapseAuditTrail} refuses a
 * breakdown whose components disagree, before any SQL is issued.
 *
 * The guard, and not merely a test over today's producers, because the risk is
 * an adapter that does not exist yet: adapters are the pluggable part of this
 * system, every external carrier is one, and a test over the two current
 * writers cannot see the third. `quote-audit-trail.test.ts` carries both — the
 * guard's own cases, and an assertion that today's producers really are
 * uniform, so `pricing.service` diverging goes red naming `pricing.service`.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FairMoney, PriceBreakdown, QuoteSource, QuoteStatus } from '@moovo/shared-types';
import { FAIR_CURRENCY } from '@moovo/shared-types';
import { uuidv7 } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { quotes } from '../schema/transport';

/** A `quotes` row exactly as stored. */
export type QuoteRow = typeof quotes.$inferSelect;

/**
 * A persisted quote, in the shape its consumers read.
 *
 * The nested `priceBreakdown` is reassembled from the six columns, because that
 * is what `job.service` freezes onto a job and what `shipment-hydration`
 * converts for display. `id` rather than `_id`, as everywhere else in the port.
 */
export interface QuoteRecord {
  id: string;
  shipmentId: string;
  source: QuoteSource;
  providerId?: string;
  providerQuoteRef?: string;
  priceBreakdown: PriceBreakdown;
  currency: typeof FAIR_CURRENCY;
  etaPickupMin?: number;
  etaDeliveryMin?: number;
  expiresAt: Date;
  status: QuoteStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** What creating one quote needs. */
export interface NewQuote {
  shipmentId: string;
  source: QuoteSource;
  providerId?: string | undefined;
  providerQuoteRef?: string | undefined;
  priceBreakdown: PriceBreakdown;
  etaPickupMin?: number | undefined;
  etaDeliveryMin?: number | undefined;
  expiresAt: Date;
  status: QuoteStatus;
}

/** The audit pair a whole breakdown agrees on. */
interface AuditTrail {
  originalCurrency: string | null;
}

/** The six components, named, so a refusal can say WHICH one disagrees. */
function componentEntries(breakdown: PriceBreakdown): Array<[string, FairMoney]> {
  const entries: Array<[string, FairMoney]> = [
    ['base', breakdown.base],
    ['distance', breakdown.distance],
    ['size', breakdown.size],
    ['total', breakdown.total],
  ];
  if (breakdown.surge) entries.push(['surge', breakdown.surge]);
  if (breakdown.fees) entries.push(['fees', breakdown.fees]);
  return entries;
}

/**
 * Reduce the six per-component audit pairs to the one the table can store,
 * refusing anything the single pair cannot faithfully represent.
 *
 * Two distinct refusals, because they have different causes and different fixes:
 *
 *  - **Components disagree on `originalCurrency`.** The table can hold one
 *    value; storing whichever component this function read first would be a
 *    silent, permanent falsification of a money audit trail. Fix: six pairs and
 *    an additive migration.
 *  - **Any component sets `originalAmount` at all.** `quotes.original_amount`
 *    is `moneyMinor()` — a `bigint` of MINOR units — while
 *    `FairMoney.originalAmount` is documented as a decimal MAJOR unit (`9.99`
 *    for 9.99 EUR). The column cannot represent the value: a decimal is
 *    rejected outright and an integer is silently off by the currency's
 *    precision. Nothing writes it today, which is why the mismatch has never
 *    bitten. Fix: correct the column's type, in the same migration as the six
 *    pairs — whoever adds a non-FAIR adapter needs both.
 *
 * Refusing rather than coercing is the fail-closed direction: a quote that will
 * not save is a visible incident, and a quote that saved a wrong original
 * currency is a number somebody reconciles against months later.
 */
export function collapseAuditTrail(breakdown: PriceBreakdown): AuditTrail {
  const entries = componentEntries(breakdown);

  const withAmount = entries.filter(([, money]) => money.originalAmount !== undefined);
  if (withAmount.length > 0) {
    throw new Error(
      `Quote price breakdown sets originalAmount on ${withAmount.map(([name]) => name).join(', ')}, ` +
        'which quotes.original_amount cannot store: the column is bigint minor units and ' +
        'FairMoney.originalAmount is a decimal major unit. Fix the column type before writing it.',
    );
  }

  const currencies = new Map<string | null, string[]>();
  for (const [name, money] of entries) {
    const currency = money.originalCurrency ?? null;
    const seen = currencies.get(currency);
    if (seen) {
      seen.push(name);
    } else {
      currencies.set(currency, [name]);
    }
  }

  if (currencies.size > 1) {
    const described = [...currencies.entries()]
      .map(([currency, names]) => `${names.join('/')}=${currency ?? 'absent'}`)
      .join(', ');
    throw new Error(
      `Quote price breakdown components disagree on originalCurrency (${described}); ` +
        'quotes stores one pair per breakdown, so this needs per-component columns and a migration.',
    );
  }

  const [only] = [...currencies.keys()];
  return { originalCurrency: only ?? null };
}

/** Rebuild one component from its column, carrying the breakdown-wide audit pair. */
function toFairMoney(fairMinor: number, originalCurrency: string | null): FairMoney {
  const money: FairMoney = { fairMinor };
  if (originalCurrency !== null) {
    money.originalCurrency = originalCurrency as FairMoney['originalCurrency'];
  }
  return money;
}

/** Reassemble the nested breakdown from the six columns. */
function toPriceBreakdown(row: QuoteRow): PriceBreakdown {
  const breakdown: PriceBreakdown = {
    base: toFairMoney(row.baseFairMinor, row.originalCurrency),
    distance: toFairMoney(row.distanceFairMinor, row.originalCurrency),
    size: toFairMoney(row.sizeFairMinor, row.originalCurrency),
    total: toFairMoney(row.totalFairMinor, row.originalCurrency),
  };
  if (row.surgeFairMinor !== null) {
    breakdown.surge = toFairMoney(row.surgeFairMinor, row.originalCurrency);
  }
  if (row.feesFairMinor !== null) {
    breakdown.fees = toFairMoney(row.feesFairMinor, row.originalCurrency);
  }
  return breakdown;
}

/** Assemble the record a consumer reads from one row. */
export function toQuoteRecord(row: QuoteRow): QuoteRecord {
  const record: QuoteRecord = {
    id: row.id,
    shipmentId: row.shipmentId,
    /**
     * The three narrowings below are the column CHECKs, restated for the
     * compiler. `quotes_source_check`, `quotes_status_check` and
     * `quotes_currency_check` are each rendered from the same `as const` tuple
     * that defines the union, so a value outside it cannot be stored — but
     * drizzle types a `text` column as `string` and has no way to know that.
     */
    source: row.source as QuoteSource,
    priceBreakdown: toPriceBreakdown(row),
    currency: row.currency as typeof FAIR_CURRENCY,
    expiresAt: row.expiresAt,
    status: row.status as QuoteStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.providerId !== null) record.providerId = row.providerId;
  if (row.providerQuoteRef !== null) record.providerQuoteRef = row.providerQuoteRef;
  if (row.etaPickupMin !== null) record.etaPickupMin = row.etaPickupMin;
  if (row.etaDeliveryMin !== null) record.etaDeliveryMin = row.etaDeliveryMin;
  return record;
}

/**
 * Write a batch of quotes — the internal one plus whatever the fan-out
 * produced — and return them in the order given.
 *
 * One statement rather than a loop, matching the source's `insertMany`. The
 * audit-trail collapse runs per quote BEFORE any SQL is issued, so a divergent
 * breakdown anywhere in the batch refuses the whole batch rather than writing a
 * partially-falsified set.
 */
export async function insertQuotes(
  inputs: readonly NewQuote[],
  db: DatabaseOrTransaction = getDb(),
): Promise<QuoteRecord[]> {
  if (inputs.length === 0) return [];

  const values = inputs.map((input) => {
    const audit = collapseAuditTrail(input.priceBreakdown);
    return {
      id: uuidv7(),
      shipmentId: input.shipmentId,
      source: input.source,
      providerId: input.providerId ?? null,
      providerQuoteRef: input.providerQuoteRef ?? null,
      baseFairMinor: input.priceBreakdown.base.fairMinor,
      distanceFairMinor: input.priceBreakdown.distance.fairMinor,
      sizeFairMinor: input.priceBreakdown.size.fairMinor,
      surgeFairMinor: input.priceBreakdown.surge?.fairMinor ?? null,
      feesFairMinor: input.priceBreakdown.fees?.fairMinor ?? null,
      totalFairMinor: input.priceBreakdown.total.fairMinor,
      originalCurrency: audit.originalCurrency,
      etaPickupMin: input.etaPickupMin ?? null,
      etaDeliveryMin: input.etaDeliveryMin ?? null,
      expiresAt: input.expiresAt,
      status: input.status,
    };
  });

  const rows = await db.insert(quotes).values(values).returning();
  return rows.map(toQuoteRecord);
}

/** One quote by id, or null. The shipment match is the CALLER's check, as in the source. */
export async function findQuoteById(
  quoteId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<QuoteRecord | null> {
  const [row] = await db.select().from(quotes).where(eq(quotes.id, quoteId)).limit(1);
  return row ? toQuoteRecord(row) : null;
}

/**
 * The quotes a customer may still choose between.
 *
 * `(source, createdAt)` is the source's `{source: 1, createdAt: 1}` verbatim —
 * `external_provider` sorts before `moovo_courier` alphabetically, which is the
 * order the API has always returned and is not this port's to change. `id`
 * breaks the remaining ties so an equal-microsecond pair does not order
 * arbitrarily between two requests.
 */
export async function listActiveQuotesForShipment(
  shipmentId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<QuoteRecord[]> {
  const rows = await db
    .select()
    .from(quotes)
    .where(and(eq(quotes.shipmentId, shipmentId), inArray(quotes.status, ['active', 'selected'])))
    .orderBy(asc(quotes.source), asc(quotes.createdAt), asc(quotes.id));
  return rows.map(toQuoteRecord);
}

/** Mark the chosen quote `selected` at booking. */
export async function markQuoteSelected(
  quoteId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.update(quotes).set({ status: 'selected' }).where(eq(quotes.id, quoteId));
}
