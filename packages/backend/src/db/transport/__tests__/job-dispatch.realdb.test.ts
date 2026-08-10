/**
 * `jobs`, `job_status_events`, `job_location_pings` and `job_offers` against a
 * real PostgreSQL server.
 *
 * Every property below is one a mock cannot hold, and most of them fail in the
 * direction that LOOKS like working software:
 *
 *  - **Idempotent booking.** `ON CONFLICT (idempotency_key) WHERE
 *    idempotency_key IS NOT NULL DO NOTHING` needs that `WHERE` to name the
 *    partial index as its arbiter. Without it Postgres raises `42P10` and every
 *    booking fails — clean under `tsc`, accepted by any mock. With it, two
 *    concurrent bookings converge on ONE job.
 *  - **The status CAS under concurrency.** The `status = <from>` predicate is
 *    the entire concurrency control. Two simultaneous transitions must produce
 *    one winner and ONE audit entry; without the predicate both "succeed" and
 *    the second silently overwrites the first.
 *  - **The CAS and its audit entry committing together.** Two statements can
 *    drift; a status that moved with nothing in the trail saying so is worse
 *    than a failed transition, because nothing reports it.
 *  - **Row COUNTS.** `expireLapsedOffers` reads `result.count`. An UPDATE with
 *    no `RETURNING` resolves to an EMPTY array, so a `.length` there is a
 *    constant zero that reads as a quiet sweep rather than a broken one.
 *  - **`count()` decoding.** postgres.js decodes `int8` as a STRING, and the
 *    acceptance rate SUMS these across groups. Two terminal groups is the
 *    smallest fixture that can tell a sum from a concatenation.
 *  - **The nested↔flat round trip**, the generated geography point, and the
 *    fulfilment CHECK that replaced `job.ts`'s `pre('validate')` hook.
 *  - **The moderation projection's exclusions**, against a row that genuinely
 *    holds every secret — the assertion `delivery-context.test.ts` can no
 *    longer make, because its fixture type has nowhere to put them.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PriceBreakdown } from '@moovo/shared-types';
import { uuidv7 } from '@oxyhq/db';
import {
  POSTGRES_TESTS_ENABLED,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../testDatabase';
import { findShipmentById, insertShipment } from '../shipmentRepository';
import { findQuoteById, insertQuotes } from '../quoteRepository';
import type { NewShipment } from '../shipmentShape';
import {
  casJobAccepted,
  casJobStatus,
  countJobs,
  findJobById,
  findJobByIdempotencyKey,
  findJobModerationFacts,
  findJobWithHistory,
  insertJobIfAbsent,
  insertJobStatusEvent,
  insertLocationPing,
  isJobParty,
  listJobStatusEvents,
  listJobs,
  listJobsAwaitingCourier,
  listRecentLocationPings,
  setDispatchAttempts,
} from '../jobRepository';
import {
  countOfferOutcomesForCourier,
  expireLapsedOffers,
  findLiveOfferForCourier,
  insertJobOffer,
  jobHasOfferInStatus,
  listCourierIdsWithLiveOffer,
  setOfferStatus,
  supersedeLiveOffers,
} from '../jobOfferRepository';
import { buildDeliveryResource } from '../../../services/moderation/subjects/delivery-context';
import { bookShipment } from '../../../services/job.service';
import type { NewJob } from '../jobShape';

const describeIfPostgres = POSTGRES_TESTS_ENABLED ? describe : describe.skip;

let suite: SuiteDatabase | null = null;

/**
 * The suite's raw client, non-optionally.
 *
 * A tagged template may not appear in an optional chain, so `suite?.client\`…\``
 * is a parse error rather than a lint preference — hence an accessor that
 * refuses instead of a `!`.
 */
function client(): SuiteDatabase['client'] {
  if (!suite) throw new Error('Suite database is not open');
  return suite.client;
}

/** The suite's drizzle handle, non-optionally. */
function database(): SuiteDatabase['db'] {
  if (!suite) throw new Error('Suite database is not open');
  return suite.db;
}

/** Barcelona and Girona, `[lng, lat]` in GeoJSON order. */
const BARCELONA: readonly [number, number] = [2.1734, 41.3851];
const GIRONA: readonly [number, number] = [2.8249, 41.9794];

/** Values that must never reach a jury, each uniquely searchable. */
const SECRETS = {
  pickupContactName: 'ZZPICKUPNAMEZZ',
  pickupPhone: '+34ZZPICKUPPHONEZZ',
  pickupLine1: 'ZZPICKUPSTREETZZ 1',
  pickupPostal: 'ZZ08001ZZ',
  dropoffContactName: 'ZZDROPNAMEZZ',
  dropoffPhone: '+34ZZDROPPHONEZZ',
  dropoffLine1: 'ZZDROPSTREETZZ 9',
  dropoffPostal: 'ZZ17001ZZ',
  pickupCode: 'ZZPICKUPCODEZZ',
  dropoffCode: 'ZZDROPOFFCODEZZ',
  pickupCodeHash: 'ZZPICKUPHASHZZ',
  dropoffCodeHash: 'ZZDROPOFFHASHZZ',
  recipientName: 'ZZRECIPIENTZZ',
  paymentReference: 'ZZPAYREFZZ',
} as const;

function breakdown(total: number): PriceBreakdown {
  return {
    base: { fairMinor: 100, originalCurrency: 'FAIR' },
    distance: { fairMinor: total - 150, originalCurrency: 'FAIR' },
    size: { fairMinor: 50, originalCurrency: 'FAIR' },
    total: { fairMinor: total, originalCurrency: 'FAIR' },
  };
}

function shipmentInput(): NewShipment {
  return {
    senderOxyUserId: 'sender-1',
    type: 'package',
    status: 'quoted',
    pickup: {
      location: { type: 'Point', coordinates: [...BARCELONA] },
      address: { line1: 'A 1', city: 'Barcelona', postalCode: '08001', country: 'ES' },
      contactName: 'A',
      contactPhone: '+34600000001',
    },
    dropoff: {
      location: { type: 'Point', coordinates: [...GIRONA] },
      address: { line1: 'B 2', city: 'Girona', postalCode: '17001', country: 'ES' },
      contactName: 'B',
      contactPhone: '+34600000002',
    },
    parcel: { weightKg: 1, sizeClass: 'small', pieces: 1 },
    itemDescription: 'A paper bag',
    photos: [],
    scheduling: { kind: 'now' },
  };
}

/** A shipment row every job below hangs off (`jobs.shipment_id` is an FK). */
let shipmentId = '';

/** A job with EVERY optional present — the shape a lossy mapper drops. */
function fullJob(overrides: Partial<NewJob> = {}): NewJob {
  return {
    jobNumber: `MOV-${Math.random().toString(36).slice(2, 10)}`,
    shipmentId,
    senderOxyUserId: 'sender-1',
    type: 'package',
    fulfillmentType: 'moovo_courier',
    pickupSnapshot: {
      location: { type: 'Point', coordinates: [...BARCELONA] },
      address: {
        line1: SECRETS.pickupLine1,
        line2: 'Escala B, 3r 2a',
        city: 'Barcelona',
        region: 'Catalunya',
        postalCode: SECRETS.pickupPostal,
        country: 'ES',
      },
      contactName: SECRETS.pickupContactName,
      contactPhone: SECRETS.pickupPhone,
      notes: 'Collect from reception',
    },
    dropoffSnapshot: {
      location: { type: 'Point', coordinates: [...GIRONA] },
      address: {
        line1: SECRETS.dropoffLine1,
        city: 'Girona',
        postalCode: SECRETS.dropoffPostal,
        country: 'ES',
      },
      contactName: SECRETS.dropoffContactName,
      contactPhone: SECRETS.dropoffPhone,
      notes: 'Leave with the neighbour',
    },
    parcelSnapshot: {
      weightKg: 4.25,
      dimsCm: { l: 40, w: 30, h: 20 },
      sizeClass: 'medium',
      pieces: 3,
      fragile: true,
    },
    quoteSnapshot: breakdown(600),
    totals: breakdown(600),
    pickupCode: SECRETS.pickupCode,
    pickupCodeHash: SECRETS.pickupCodeHash,
    dropoffCode: SECRETS.dropoffCode,
    dropoffCodeHash: SECRETS.dropoffCodeHash,
    ...overrides,
  };
}

/** A job with EVERY optional absent — the other half of the round trip. */
function minimalJob(overrides: Partial<NewJob> = {}): NewJob {
  return {
    jobNumber: `MOV-${Math.random().toString(36).slice(2, 10)}`,
    shipmentId,
    senderOxyUserId: 'sender-2',
    type: 'food',
    fulfillmentType: 'moovo_courier',
    pickupSnapshot: {
      location: { type: 'Point', coordinates: [...BARCELONA] },
      address: { line1: 'A 1', city: 'Barcelona', postalCode: '08001', country: 'ES' },
      contactName: 'A',
      contactPhone: '+34600000001',
    },
    dropoffSnapshot: {
      location: { type: 'Point', coordinates: [...GIRONA] },
      address: { line1: 'B 2', city: 'Girona', postalCode: '17001', country: 'ES' },
      contactName: 'B',
      contactPhone: '+34600000002',
    },
    parcelSnapshot: { weightKg: 1, sizeClass: 'small', pieces: 1 },
    quoteSnapshot: breakdown(300),
    totals: breakdown(300),
    ...overrides,
  };
}

/** Insert a job, refusing the `null` that means a conflict cancelled it. */
async function createJob(input: NewJob = minimalJob()): Promise<string> {
  const job = await insertJobIfAbsent(input);
  if (!job) throw new Error('Job insert was cancelled by a conflict');
  return job.id;
}

/** The constraint a rejected write actually names. drizzle wraps the driver error. */
function violatedConstraint(error: unknown): string | undefined {
  const cause = (error as { cause?: { constraint_name?: string } }).cause;
  return cause?.constraint_name;
}

const OFFER_DEFAULTS = { rank: 0, distanceM: 500 };

/** Offer a job to one courier, expiring at `expiresAt`. */
async function offer(jobId: string, courierOxyUserId: string, expiresAt: Date) {
  return insertJobOffer({
    jobId,
    shipmentId,
    courierOxyUserId,
    offeredAt: new Date(),
    expiresAt,
    ...OFFER_DEFAULTS,
  });
}

describeIfPostgres('jobs and dispatch offers on a real server', () => {
  beforeAll(async () => {
    suite = await createSuiteDatabase();
  });

  afterAll(async () => {
    await destroySuiteDatabase(suite);
    suite = null;
  });

  beforeAll(async () => {
    // One shipment every job hangs off — `jobs.shipment_id` is a foreign key,
    // and `afterEach` deletes only jobs, so it survives the whole file.
    const shipment = await insertShipment(shipmentInput());
    shipmentId = shipment.id;
  });

  afterEach(async () => {
    // Offers, status events and pings cascade from jobs; the booking cases below
    // create shipments of their own, so those go too and the shared one is
    // re-seeded. Jobs are deleted FIRST: `jobs.shipment_id` is `ON DELETE
    // restrict`, deliberately, so a booked shipment cannot be removed under a
    // live job.
    await client()`DELETE FROM jobs`;
    await client()`DELETE FROM shipments`;
    const shipment = await insertShipment(shipmentInput());
    shipmentId = shipment.id;
  });

  describe('the nested↔flat round trip', () => {
    it('returns every field of a fully-populated job unchanged', async () => {
      const input = fullJob();
      const id = await createJob(input);

      const read = await findJobById(id);

      expect(read?.pickupSnapshot).toEqual(input.pickupSnapshot);
      expect(read?.dropoffSnapshot).toEqual(input.dropoffSnapshot);
      expect(read?.parcelSnapshot).toEqual(input.parcelSnapshot);
      expect(read?.quoteSnapshot).toEqual(input.quoteSnapshot);
      expect(read?.totals).toEqual(input.totals);
      expect(read?.pickupCode).toBe(SECRETS.pickupCode);
      expect(read?.dropoffCodeHash).toBe(SECRETS.dropoffCodeHash);
    });

    it('omits every absent optional rather than returning nulls', async () => {
      const input = minimalJob();
      const id = await createJob(input);

      const read = await findJobById(id);

      expect(read?.pickupSnapshot).toEqual(input.pickupSnapshot);
      expect(read?.parcelSnapshot).toEqual({ weightKg: 1, sizeClass: 'small', pieces: 1, fragile: false });
      expect(read).not.toHaveProperty('providerRef');
      expect(read).not.toHaveProperty('courierOxyUserId');
      expect(read).not.toHaveProperty('proofOfDelivery');
      expect(read).not.toHaveProperty('idempotencyKey');
      // The payment sub-document's two defaults survive the port as columns.
      expect(read?.payment).toEqual({ status: 'unpaid', provider: 'oxy_pay' });
    });

    /**
     * `pickup_location` is `GENERATED ALWAYS` from the ordinate pair, and
     * getting the order backwards does not fail — it silently puts every job in
     * the sea off Somalia. Nothing in TypeScript can check this.
     */
    it('generates the pickup point from the ordinates in ST_MakePoint order', async () => {
      const id = await createJob(fullJob());

      const [row] = await client()<{ lng: number; lat: number }[]>`
        SELECT ST_X(pickup_location::geometry) AS lng, ST_Y(pickup_location::geometry) AS lat
        FROM jobs WHERE id = ${id}
      `;

      expect(row?.lng).toBeCloseTo(BARCELONA[0], 6);
      expect(row?.lat).toBeCloseTo(BARCELONA[1], 6);
    });

    /**
     * `total_fair_minor` is GENERATED from the `totals` jsonb, so the one number
     * the product shows a courier cannot drift from the snapshot it came from.
     */
    it('derives total_fair_minor from the totals snapshot', async () => {
      const id = await createJob(fullJob());

      const [row] = await client()<{ total: string }[]>`
        SELECT total_fair_minor AS total FROM jobs WHERE id = ${id}
      `;

      expect(Number(row?.total)).toBe(600);
    });
  });

  /**
   * `jobs_fulfillment_shape_check` is the CHECK that replaced `job.ts`'s
   * `pre('validate')` hook — and note the ASYMMETRY, which is why it is written
   * out rather than copied from the `listings` owner split: an UNASSIGNED
   * `moovo_courier` job is legal and ordinary.
   */
  describe('the fulfilment CHECK that replaced the validate hook', () => {
    it('refuses an external-provider job with no providerRef', async () => {
      await expect(
        createJob(minimalJob({ fulfillmentType: 'external_provider' })),
      ).rejects.toSatisfy((err: unknown) => violatedConstraint(err) === 'jobs_fulfillment_shape_check');
    });

    it('refuses a moovo_courier job carrying a providerRef', async () => {
      await expect(
        createJob(minimalJob({ providerRef: 'carrier-ref-1' })),
      ).rejects.toSatisfy((err: unknown) => violatedConstraint(err) === 'jobs_fulfillment_shape_check');
    });

    it('refuses an external-provider job that also names a courier', async () => {
      const id = await createJob(minimalJob({ fulfillmentType: 'external_provider', providerRef: 'ref-1' }));
      await expect(
        client()`UPDATE jobs SET courier_oxy_user_id = 'c1' WHERE id = ${id}`,
      ).rejects.toSatisfy((err: unknown) => err !== undefined);
    });

    it('ACCEPTS an unassigned moovo_courier job, which is what every job looks like at first', async () => {
      const id = await createJob(minimalJob());
      const read = await findJobById(id);
      expect(read?.status).toBe('requested');
      expect(read).not.toHaveProperty('courierOxyUserId');
    });
  });

  /**
   * The port of `catch (11000)`, and the reason there is no SAVEPOINT anywhere
   * in this domain: the insert never fails, so there is no aborted transaction
   * to recover from.
   */
  describe('idempotent booking', () => {
    it('a repeated booking under one key cancels the insert and converges on the prior job', async () => {
      const first = await insertJobIfAbsent(minimalJob({ idempotencyKey: 'idem-1' }));
      const second = await insertJobIfAbsent(minimalJob({ idempotencyKey: 'idem-1' }));

      expect(first).not.toBeNull();
      // The empty result IS the answer, and it arrives with no error raised.
      expect(second).toBeNull();

      const prior = await findJobByIdempotencyKey('idem-1');
      expect(prior?.id).toBe(first?.id);

      const [row] = await client()<{ total: string }[]>`SELECT count(*) AS total FROM jobs`;
      expect(Number(row?.total)).toBe(1);
    });

    it('two CONCURRENT bookings under one key produce exactly one job', async () => {
      const [a, b] = await Promise.all([
        insertJobIfAbsent(minimalJob({ idempotencyKey: 'idem-race' })),
        insertJobIfAbsent(minimalJob({ idempotencyKey: 'idem-race' })),
      ]);

      // Exactly one winner; the loser is told nothing was inserted.
      expect([a, b].filter((job) => job !== null)).toHaveLength(1);
      const [row] = await client()<{ total: string }[]>`SELECT count(*) AS total FROM jobs`;
      expect(Number(row?.total)).toBe(1);
    });

    /**
     * A job with no key never satisfies the partial index's predicate, so it can
     * raise no conflict there — two keyless bookings are two jobs, which is what
     * a caller who supplied no idempotency key asked for.
     */
    it('does not deduplicate bookings that carry no key', async () => {
      await createJob(minimalJob());
      await createJob(minimalJob());

      const [row] = await client()<{ total: string }[]>`SELECT count(*) AS total FROM jobs`;
      expect(Number(row?.total)).toBe(2);
    });

    /**
     * Naming the arbiter means only THAT index cancels the insert. A duplicate
     * job number is a broken sequence, not a replayed booking, and must surface.
     */
    it('does NOT swallow a duplicate job number', async () => {
      await createJob(minimalJob({ jobNumber: 'MOV-DUP' }));

      await expect(
        insertJobIfAbsent(minimalJob({ jobNumber: 'MOV-DUP', idempotencyKey: 'other-key' })),
      ).rejects.toSatisfy((err: unknown) => violatedConstraint(err) === 'jobs_job_number_key');
    });
  });

  /**
   * `bookShipment` end to end, because the transaction it opens is the thing
   * this port CHANGED and no other test reaches it.
   *
   * The source wrote the job, then marked the quote selected, then marked the
   * shipment booked, as three independent operations — and a crash after the
   * first left the shipment `quoted` with no `jobId`, so the "already booked"
   * early return never fired and every retry converged on the prior job and
   * returned BEFORE the two marks, permanently. The assertions below are that
   * all four writes land, and that a replay changes nothing.
   *
   * Dispatch runs at the end of a booking and is deliberately left real: with no
   * courier profiles seeded it finds no candidates, returns, and leaves the job
   * `requested`, which is the "zero candidates is not a failure" path.
   */
  describe('booking a shipment into a job', () => {
    async function bookableQuote(shipment: string): Promise<string> {
      const [quote] = await insertQuotes([
        {
          shipmentId: shipment,
          source: 'moovo_courier',
          priceBreakdown: breakdown(450),
          expiresAt: new Date(Date.now() + 600_000),
          status: 'active',
        },
      ]);
      if (!quote) throw new Error('quote insert returned nothing');
      return quote.id;
    }

    /** A shipment of its own, since booking mutates it. */
    async function freshShipment(): Promise<string> {
      const created = await insertShipment(shipmentInput());
      return created.id;
    }

    it('writes the job, its first status event, the quote and the shipment as one', async () => {
      const ship = await freshShipment();
      const quote = await bookableQuote(ship);

      const job = await bookShipment('sender-1', ship, quote, 'book-idem-1');

      expect(job.status).toBe('requested');
      // The initial audit entry commits WITH the job — a job whose trail is
      // empty is a job nobody can say who created.
      expect(job.statusHistory).toEqual([
        expect.objectContaining({ status: 'requested', byOxyUserId: 'sender-1' }),
      ]);
      expect((await findQuoteById(quote))?.status).toBe('selected');
      const booked = await findShipmentById(ship);
      expect(booked?.status).toBe('booked');
      expect(booked?.jobId).toBe(job.id);
      expect(booked?.quoteRef).toBe(quote);
    });

    it('mints the two QR codes for a courier job, and stores a hash beside each', async () => {
      const ship = await freshShipment();
      const quote = await bookableQuote(ship);

      const job = await bookShipment('sender-1', ship, quote, 'book-idem-codes');

      expect(job.pickupCode).toBeDefined();
      expect(job.dropoffCode).toBeDefined();
      // The courier scans against the HASH; the plaintext is the sender's.
      expect(job.pickupCodeHash).toBeDefined();
      expect(job.pickupCodeHash).not.toBe(job.pickupCode);
    });

    /**
     * A SEQUENTIAL replay never reaches the idempotency key, and saying so is
     * the point of this test's name.
     *
     * It is short-circuited far earlier, by the shipment's own `booked` state
     * and its `jobId`. Measured: removing the idempotency key from the insert
     * entirely leaves this case GREEN, because the second call returns before
     * any insert is attempted. A test named for the key here would claim to
     * exercise a mechanism it never touches — the case below is the one that
     * does.
     */
    it('a sequential re-submit returns the booked job without reaching the insert', async () => {
      const ship = await freshShipment();
      const quote = await bookableQuote(ship);

      const first = await bookShipment('sender-1', ship, quote, 'book-idem-replay');
      const second = await bookShipment('sender-1', ship, quote, 'book-idem-replay');

      expect(second.id).toBe(first.id);
      expect(await countJobs({ senderOxyUserId: 'sender-1' })).toBe(1);
      // One audit entry, not two: the second call writes nothing at all.
      expect(second.statusHistory).toHaveLength(1);
    });

    /**
     * The case the idempotency key actually exists for.
     *
     * Two callers read the shipment as still `quoted` — neither can see the
     * other's uncommitted booking — so both reach the insert, and only the key
     * stops the second becoming a second job. This is the shape a double-tap or
     * a retried request produces, and it is the ONLY one that discriminates:
     * mutation-tested by dropping the key from the insert, which leaves the
     * sequential case above green and turns this one red with two jobs.
     *
     * The loser's convergence read runs in its own transaction, opened before
     * the winner committed, and finds the row because the default isolation is
     * READ COMMITTED — each statement takes a fresh snapshot.
     */
    it('two CONCURRENT bookings of one shipment produce exactly one job', async () => {
      const ship = await freshShipment();
      const quote = await bookableQuote(ship);

      const [a, b] = await Promise.all([
        bookShipment('sender-1', ship, quote, 'book-idem-race'),
        bookShipment('sender-1', ship, quote, 'book-idem-race'),
      ]);

      expect(a.id).toBe(b.id);
      expect(await countJobs({ senderOxyUserId: 'sender-1' })).toBe(1);
      expect(a.statusHistory).toHaveLength(1);
    });

    it('refuses a quote belonging to another shipment', async () => {
      const ship = await freshShipment();
      const other = await freshShipment();
      const quote = await bookableQuote(other);

      await expect(bookShipment('sender-1', ship, quote, 'book-idem-x')).rejects.toThrow();
      expect(await countJobs({ senderOxyUserId: 'sender-1' })).toBe(0);
    });

    it('refuses a shipment the caller does not own, before anything is written', async () => {
      const ship = await freshShipment();
      const quote = await bookableQuote(ship);

      await expect(bookShipment('not-the-sender', ship, quote, 'book-idem-y')).rejects.toThrow();
      expect(await countJobs({ senderOxyUserId: 'sender-1' })).toBe(0);
      expect((await findShipmentById(ship))?.status).toBe('quoted');
    });
  });

  describe('the status CAS', () => {
    it('moves the job and returns the row it wrote', async () => {
      const id = await createJob(minimalJob());

      const moved = await casJobStatus({ jobId: id, from: 'requested', to: 'offered' });

      expect(moved?.status).toBe('offered');
      expect((await findJobById(id))?.status).toBe('offered');
    });

    it('refuses when the job has already left the expected status', async () => {
      const id = await createJob(minimalJob());
      await casJobStatus({ jobId: id, from: 'requested', to: 'offered' });

      const late = await casJobStatus({ jobId: id, from: 'requested', to: 'cancelled' });

      // The empty result — not a count, not an exception — is what tells the
      // service somebody else got there first.
      expect(late).toBeNull();
      expect((await findJobById(id))?.status).toBe('offered');
    });

    /**
     * The property the predicate exists for.
     *
     * Two simultaneous transitions out of one status: exactly one may win.
     * Without `status = <from>` both statements match, both report a row, and
     * the second silently overwrites the first — which looks like working
     * software from every angle except the audit trail.
     */
    it('admits exactly ONE of two concurrent transitions out of the same status', async () => {
      const id = await createJob(minimalJob());

      const [accepted, cancelled] = await Promise.all([
        casJobStatus({ jobId: id, from: 'requested', to: 'accepted' }),
        casJobStatus({ jobId: id, from: 'requested', to: 'cancelled' }),
      ]);

      const winners = [accepted, cancelled].filter((row) => row !== null);
      expect(winners).toHaveLength(1);
      expect((await findJobById(id))?.status).toBe(winners[0]?.status);
    });

    it('assigns the courier in the SAME statement that takes the job', async () => {
      const id = await createJob(minimalJob());
      await casJobStatus({ jobId: id, from: 'requested', to: 'offered' });

      const [first, second] = await Promise.all([
        casJobAccepted(id, 'courier-a'),
        casJobAccepted(id, 'courier-b'),
      ]);

      const winner = [first, second].find((row) => row !== null);
      expect([first, second].filter((row) => row !== null)).toHaveLength(1);
      // The loser cannot have applied its assignment, because the assignment and
      // the status change are one statement.
      const read = await findJobById(id);
      expect(read?.status).toBe('accepted');
      expect(read?.courierOxyUserId).toBe(winner?.courierOxyUserId);
    });

    /**
     * The CAS and its audit entry are ONE commit.
     *
     * A rolled-back transaction must leave neither — the source got this for
     * free from a single-document `$set` plus `$push`, and two statements can
     * drift. A status that moved with nothing in the trail saying so is the
     * worse failure, because nothing reports it.
     */
    it('rolls back BOTH the status change and its audit entry together', async () => {
      const id = await createJob(minimalJob());

      await expect(
        database().transaction(async (tx) => {
          await casJobStatus({ jobId: id, from: 'requested', to: 'offered' }, tx);
          await insertJobStatusEvent({ jobId: id, status: 'offered', at: new Date() }, tx);
          throw new Error('abandon the transition');
        }),
      ).rejects.toThrow('abandon the transition');

      /**
       * Both statements really JOINED the caller's transaction.
       *
       * A repository that reached for `getDb()` instead of using the handle it
       * was passed type-checks perfectly, opens a second connection, and commits
       * outside the block — so the row it wrote survives a rollback. That is the
       * shape this asserts: either survivor here means the two halves of one
       * transition can be left disagreeing, which is worse than a failed
       * transition because nothing reports it.
       */
      expect((await findJobById(id))?.status).toBe('requested');
      expect(await listJobStatusEvents(id)).toHaveLength(0);
    });
  });

  /**
   * Ordering is by `at`, with `id` breaking ties and meaning nothing else — the
   * ids are uuid v7 and are NOT monotonic within a millisecond, so every case
   * here writes EXPLICIT, distinct timestamps rather than relying on insert
   * order. A test that did rely on it would pass or fail at random.
   */
  describe('the two child trails', () => {
    it('returns the audit trail oldest first, by its own timestamps', async () => {
      const id = await createJob(minimalJob());
      // Written out of order on purpose: the reader must sort, not echo.
      await insertJobStatusEvent({ jobId: id, status: 'accepted', at: new Date('2026-07-01T10:02:00Z') });
      await insertJobStatusEvent({ jobId: id, status: 'requested', at: new Date('2026-07-01T10:00:00Z') });
      await insertJobStatusEvent({ jobId: id, status: 'offered', at: new Date('2026-07-01T10:01:00Z') });

      const trail = await listJobStatusEvents(id);

      expect(trail.map((event) => event.status)).toEqual(['requested', 'offered', 'accepted']);
    });

    it("round-trips an event's actor, note and location", async () => {
      const id = await createJob(minimalJob());
      await insertJobStatusEvent({
        jobId: id,
        status: 'picked_up',
        at: new Date('2026-07-01T10:00:00Z'),
        byOxyUserId: 'courier-1',
        note: 'pickup scanned',
        location: { type: 'Point', coordinates: [...BARCELONA] },
      });

      const [event] = await listJobStatusEvents(id);

      expect(event).toEqual({
        status: 'picked_up',
        at: new Date('2026-07-01T10:00:00Z'),
        byOxyUserId: 'courier-1',
        note: 'pickup scanned',
        location: { type: 'Point', coordinates: [...BARCELONA] },
      });
    });

    it('omits a location entirely rather than emitting a half point', async () => {
      const id = await createJob(minimalJob());
      await insertJobStatusEvent({ jobId: id, status: 'offered', at: new Date('2026-07-01T10:00:00Z') });

      const [event] = await listJobStatusEvents(id);

      expect(event).not.toHaveProperty('location');
    });

    it('refuses a status event carrying one ordinate without the other', async () => {
      const id = await createJob(minimalJob());

      await expect(
        client()`
          INSERT INTO job_status_events (id, job_id, status, at, latitude)
          VALUES (${uuidv7()}, ${id}, 'offered', now(), 41.3851)
        `,
      ).rejects.toSatisfy((err: unknown) => err !== undefined);
    });

    /**
     * The cap moved from the WRITE to the READ.
     *
     * The source pruned the stored trail with `$push … $slice: -N` because an
     * unbounded array grows one Mongo document without bound. Every ping is kept
     * here and the reader takes the most recent N, ascending, which is what the
     * source's array held — with nothing destroyed to produce it.
     */
    it('keeps every ping and reads back the most recent N, oldest first', async () => {
      const id = await createJob(minimalJob());
      for (let minute = 0; minute < 8; minute += 1) {
        await insertLocationPing(id, {
          longitude: BARCELONA[0] + minute / 1000,
          latitude: BARCELONA[1],
          at: new Date(Date.UTC(2026, 6, 1, 10, minute)),
        });
      }

      const recent = await listRecentLocationPings(id, 3);

      expect(recent.map((ping) => ping.at)).toEqual([
        new Date(Date.UTC(2026, 6, 1, 10, 5)),
        new Date(Date.UTC(2026, 6, 1, 10, 6)),
        new Date(Date.UTC(2026, 6, 1, 10, 7)),
      ]);
      // Nothing was pruned to produce that window.
      const [row] = await client()<{ total: string }[]>`SELECT count(*) AS total FROM job_location_pings`;
      expect(Number(row?.total)).toBe(8);
    });

    it('loads both trails onto one job', async () => {
      const id = await createJob(minimalJob());
      await insertJobStatusEvent({ jobId: id, status: 'requested', at: new Date('2026-07-01T10:00:00Z') });
      await insertLocationPing(id, { longitude: BARCELONA[0], latitude: BARCELONA[1], at: new Date() });

      const job = await findJobWithHistory(id, 100);

      expect(job?.statusHistory).toHaveLength(1);
      expect(job?.locationPings).toHaveLength(1);
    });
  });

  describe('listing and counting', () => {
    it('counts through drizzle so a page total is a NUMBER, not a string', async () => {
      await createJob(minimalJob({ senderOxyUserId: 'sender-count' }));
      await createJob(minimalJob({ senderOxyUserId: 'sender-count' }));

      const total = await countJobs({ senderOxyUserId: 'sender-count' });

      expect(total).toBe(2);
      expect(typeof total).toBe('number');
      // The string really is one respelling away — pin it so the reasoning in
      // the repository cannot rot into a comment nobody can check.
      const [raw] = await client()<{ total: string }[]>`SELECT count(*) AS total FROM jobs`;
      expect(typeof raw?.total).toBe('string');
    });

    it("lists a courier's own moovo_courier jobs, newest first", async () => {
      const older = await createJob(minimalJob());
      const newer = await createJob(minimalJob());
      await client()`UPDATE jobs SET courier_oxy_user_id = 'courier-x', created_at = '2026-07-01T10:00:00Z' WHERE id = ${older}`;
      await client()`UPDATE jobs SET courier_oxy_user_id = 'courier-x', created_at = '2026-07-02T10:00:00Z' WHERE id = ${newer}`;

      const page = await listJobs(
        { courierOxyUserId: 'courier-x', fulfillmentType: 'moovo_courier' },
        { page: 1, limit: 10 },
      );

      expect(page.map((job) => job.id)).toEqual([newer, older]);
    });

    it('finds only moovo_courier jobs still awaiting one', async () => {
      const waiting = await createJob(minimalJob());
      const taken = await createJob(minimalJob());
      await casJobStatus({ jobId: taken, from: 'requested', to: 'offered' });
      await casJobAccepted(taken, 'courier-y');
      const external = await createJob(
        minimalJob({ fulfillmentType: 'external_provider', providerRef: 'ref-1' }),
      );

      const awaiting = await listJobsAwaitingCourier(['requested', 'offered']);

      const ids = awaiting.map((job) => job.id);
      expect(ids).toContain(waiting);
      expect(ids).not.toContain(taken);
      expect(ids).not.toContain(external);
    });

    it('records a dispatch wave', async () => {
      const id = await createJob(minimalJob());
      await setDispatchAttempts(id, 2);
      expect((await findJobById(id))?.dispatchAttempts).toBe(2);
    });
  });

  /**
   * `isJobParty` is the IDOR guard on attaching a delivery to an abuse report: a
   * delivery description is another customer's business, and without it anyone
   * could report any account, attach any job id, and read it back.
   *
   * The predicate is a WHERE clause now, so this is the only place it can be
   * checked — and BOTH parties matter, since a courier reporting a customer is
   * as legitimate as the reverse.
   */
  describe('the report-context ownership predicate', () => {
    it('admits the sender and the assigned courier, and nobody else', async () => {
      const id = await createJob(minimalJob({ senderOxyUserId: 'the-sender' }));
      await casJobStatus({ jobId: id, from: 'requested', to: 'offered' });
      await casJobAccepted(id, 'the-courier');

      expect(await isJobParty(id, 'the-sender')).toBe(true);
      expect(await isJobParty(id, 'the-courier')).toBe(true);
      expect(await isJobParty(id, 'a-stranger')).toBe(false);
    });

    it('answers false for a job that does not exist', async () => {
      expect(await isJobParty(uuidv7(), 'the-sender')).toBe(false);
    });
  });

  /**
   * The delivery-code assertions `delivery-context.test.ts` can no longer make.
   *
   * Its fixture is the projection TYPE, which has nowhere to put a code, a phone
   * number or a street — so the leak proof belongs here, where a real row
   * genuinely holds all of them when the assertion runs.
   */
  describe('the moderation projection', () => {
    async function seedSecretiveJob(): Promise<string> {
      const id = await createJob(fullJob());
      await client()`
        UPDATE jobs
        SET payment_reference = ${SECRETS.paymentReference},
            pod_recipient_name = ${SECRETS.recipientName},
            pod_note = 'Handed over at the door',
            pod_at = now()
        WHERE id = ${id}
      `;
      return id;
    }

    it('never loads a code, a hash, a contact, a street or a payment reference', async () => {
      const id = await seedSecretiveJob();

      const facts = await findJobModerationFacts(id);

      const serialised = JSON.stringify(facts);
      for (const [name, secret] of Object.entries(SECRETS)) {
        expect(serialised, `projection leaked ${name}`).not.toContain(secret);
      }
    });

    it('never emits one through the assembled jury description either', async () => {
      const id = await seedSecretiveJob();
      const facts = await findJobModerationFacts(id);
      if (!facts) throw new Error('projection returned nothing');

      const serialised = JSON.stringify(await buildDeliveryResource(facts));

      for (const [name, secret] of Object.entries(SECRETS)) {
        expect(serialised, `description leaked ${name}`).not.toContain(secret);
      }
      // Coordinates are DROPPED, not coarsened — assert on leading digits so a
      // rounded value fails too.
      expect(serialised).not.toContain('41.38');
      expect(serialised).not.toContain('2.17');
      expect(serialised).not.toContain('coordinates');
    });

    it('still carries the coarse material a jury needs', async () => {
      const id = await seedSecretiveJob();
      const facts = await findJobModerationFacts(id);

      expect(facts?.pickupCity).toBe('Barcelona');
      expect(facts?.pickupRegion).toBe('Catalunya');
      expect(facts?.dropoffNotes).toBe('Leave with the neighbour');
      expect(facts?.proofNote).toBe('Handed over at the door');
    });
  });

  describe('dispatch offers', () => {
    it("finds only the caller's own LIVE offer", async () => {
      const id = await createJob(minimalJob());
      const mine = await offer(id, 'courier-a', new Date(Date.now() + 60_000));
      await offer(id, 'courier-b', new Date(Date.now() + 60_000));

      expect((await findLiveOfferForCourier(id, 'courier-a'))?.id).toBe(mine.id);
      expect(await findLiveOfferForCourier(id, 'courier-c')).toBeNull();

      await setOfferStatus(mine.id, 'expired');
      expect(await findLiveOfferForCourier(id, 'courier-a')).toBeNull();
    });

    it('excludes couriers already holding a live offer from the next wave', async () => {
      const id = await createJob(minimalJob());
      await offer(id, 'courier-a', new Date(Date.now() + 60_000));
      const stale = await offer(id, 'courier-b', new Date(Date.now() + 60_000));
      await setOfferStatus(stale.id, 'expired');

      const excluded = await listCourierIdsWithLiveOffer(id);

      // A courier whose offer already lapsed may be offered the job again.
      expect(excluded).toEqual(['courier-a']);
    });

    /**
     * The supersede REPORTS whose offers it took, in one statement.
     *
     * Reading the list first and updating after can tell a courier their offer
     * was taken when the update then matched nothing, and can miss one that
     * became live in between.
     */
    it('supersedes every live sibling, spares the winner, and names exactly whom it took', async () => {
      const id = await createJob(minimalJob());
      const winner = await offer(id, 'courier-a', new Date(Date.now() + 60_000));
      await offer(id, 'courier-b', new Date(Date.now() + 60_000));
      await offer(id, 'courier-c', new Date(Date.now() + 60_000));
      const alreadyExpired = await offer(id, 'courier-d', new Date(Date.now() + 60_000));
      await setOfferStatus(alreadyExpired.id, 'expired');

      const taken = await supersedeLiveOffers(id, winner.id);

      expect(taken.sort()).toEqual(['courier-b', 'courier-c']);
      expect((await findLiveOfferForCourier(id, 'courier-a'))?.id).toBe(winner.id);
    });

    it('supersedes every live offer when no winner is spared (a cancel)', async () => {
      const id = await createJob(minimalJob());
      await offer(id, 'courier-a', new Date(Date.now() + 60_000));
      await offer(id, 'courier-b', new Date(Date.now() + 60_000));

      const taken = await supersedeLiveOffers(id, undefined);

      expect(taken.sort()).toEqual(['courier-a', 'courier-b']);
      expect(await jobHasOfferInStatus(id, 'offered')).toBe(false);
    });

    it('answers whether a job has an offer in a given status', async () => {
      const id = await createJob(minimalJob());
      expect(await jobHasOfferInStatus(id, 'offered')).toBe(false);

      const live = await offer(id, 'courier-a', new Date(Date.now() + 60_000));
      expect(await jobHasOfferInStatus(id, 'offered')).toBe(true);
      expect(await jobHasOfferInStatus(id, 'accepted')).toBe(false);

      await setOfferStatus(live.id, 'accepted');
      expect(await jobHasOfferInStatus(id, 'accepted')).toBe(true);
    });

    /**
     * The one bare row COUNT in this port.
     *
     * `expireLapsedOffers` has no `RETURNING`, so its result array is EMPTY
     * whether it changed a thousand rows or none — a `.length` here is a
     * constant zero that reads as a quiet sweep rather than a broken one. The
     * assertion is the NUMBER, which only `result.count` can produce.
     */
    it('reports how many lapsed offers it flipped, and flips only those', async () => {
      const id = await createJob(minimalJob());
      const past = new Date(Date.now() - 60_000);
      await offer(id, 'courier-a', past);
      await offer(id, 'courier-b', past);
      await offer(id, 'courier-c', new Date(Date.now() + 60_000));
      const alreadyAccepted = await offer(id, 'courier-d', past);
      await setOfferStatus(alreadyAccepted.id, 'accepted');

      const flipped = await expireLapsedOffers(new Date());

      expect(flipped).toBe(2);
      // The still-live offer is untouched, and so is the accepted one — the flip
      // is semantic and only ever acts on offers a courier could still win.
      expect((await findLiveOfferForCourier(id, 'courier-c'))?.courierOxyUserId).toBe('courier-c');
      const [row] = await client()<{ total: string }[]>`
        SELECT count(*) AS total FROM job_offers WHERE status = 'accepted'
      `;
      expect(Number(row?.total)).toBe(1);
    });

    it('reports zero when nothing has lapsed', async () => {
      const id = await createJob(minimalJob());
      await offer(id, 'courier-a', new Date(Date.now() + 60_000));

      expect(await expireLapsedOffers(new Date())).toBe(0);
    });

    /**
     * The acceptance-rate aggregate, and the fixture shape that makes it
     * meaningful.
     *
     * postgres.js decodes `int8` as a STRING, and the caller SUMS these across
     * groups: with strings, `0 + "3"` is `"3"` and `"3" + "2"` is `"32"`. TWO
     * terminal groups is the smallest fixture that can tell a sum from a
     * concatenation — one group divides correctly under either semantics, so a
     * single-group test would pass while measuring nothing.
     */
    it("groups a courier's offer outcomes as NUMBERS, across more than one group", async () => {
      const id = await createJob(minimalJob());
      const soon = new Date(Date.now() + 60_000);
      const accepted = await offer(id, 'courier-rate', soon);
      await setOfferStatus(accepted.id, 'accepted');
      for (let i = 0; i < 2; i += 1) {
        const expired = await offer(id, 'courier-rate', soon);
        await setOfferStatus(expired.id, 'expired');
      }
      const declined = await offer(id, 'courier-rate', soon);
      await setOfferStatus(declined.id, 'declined');
      // Still in flight — excluded from the denominator by the caller.
      await offer(id, 'courier-rate', soon);

      const outcomes = await countOfferOutcomesForCourier('courier-rate');

      for (const outcome of outcomes) {
        expect(typeof outcome.count).toBe('number');
      }
      const resolved = outcomes
        .filter((outcome) => outcome.status !== 'offered')
        .reduce((sum, outcome) => sum + outcome.count, 0);
      // 1 accepted + 2 expired + 1 declined. String concatenation would give
      // "12" or "121" here, never 4.
      expect(resolved).toBe(4);
      expect(outcomes.find((outcome) => outcome.status === 'accepted')?.count).toBe(1);
      expect(outcomes.find((outcome) => outcome.status === 'expired')?.count).toBe(2);
    });
  });
});
