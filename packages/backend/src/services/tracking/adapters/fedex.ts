/**
 * FedEx — the first carrier with a real feed.
 *
 * ## Read this before enabling it
 *
 * The seam was always ready; what was missing is a client, and a client is an
 * HTTP CONTRACT. This one is written to FedEx's published Track API v1 and its
 * mapping is unit-tested against fixtures, but **fixtures written from a
 * specification test this file's reading of the specification, not FedEx.**
 * Until one live call has been made with real credentials and a real response
 * recorded, treat the mapping as unconfirmed. That is why enabling it takes
 * three independent things rather than a deploy:
 *
 * 1. `FEDEX_CLIENT_ID` and `FEDEX_CLIENT_SECRET`. Without both, this module
 *    hands back a deep-link-only adapter and nothing here ever runs.
 * 2. `TRACKING_ENABLED=true`, or the poll dispatcher never starts.
 * 3. `tracking_carriers.poll_supported = true` on the `fedex` row. Seeding is
 *    `ON CONFLICT DO NOTHING`, so the row that already exists in production
 *    keeps `false` no matter what this file says — an operator flips it, after
 *    the live call above.
 *
 * ## The token is cached in module state, deliberately
 *
 * FedEx issues an hour-long client-credentials token and rate-limits the token
 * endpoint far harder than the track endpoint. One token per process, refreshed
 * early, is the difference between one auth call an hour and one per parcel.
 * It is read and written only from inside `getAccessToken`, never from a
 * memoized position, and a concurrent refresh shares one in-flight promise so a
 * batch of parcels does not open a batch of auth calls.
 */

import type {
  TrackingAdapter,
  TrackingCheckpointInput,
  TrackingFetchInput,
  TrackingSnapshot,
} from '../tracking-adapter.js';
import type { TrackingStatus } from '@moovo/shared-types';
import { log } from '../../../lib/logger.js';

const DEEP_LINK_TEMPLATE = 'https://www.fedex.com/fedextrack/?trknbr={number}';

/**
 * FedEx's `derivedCode` — the stable, locale-independent one — onto the
 * tracker's vocabulary.
 *
 * `statusByLocale` is prose and changes with the `X-locale` header; `code` is
 * the coarse bucket. `derivedCode` is the one FedEx documents as the machine
 * value, so it is the one mapped. Anything unmapped becomes `in_transit`
 * WITH the raw code preserved in `rawStatus` — never `exception`, because an
 * unrecognised code is our gap and telling a customer their parcel has a
 * problem on that basis is worse than saying it is moving.
 */
const DERIVED_CODE_TO_STATUS: Record<string, TrackingStatus> = {
  IN: 'info_received',
  IT: 'in_transit',
  AR: 'in_transit',
  DP: 'in_transit',
  AF: 'in_transit',
  OD: 'out_for_delivery',
  OF: 'out_for_delivery',
  DL: 'delivered',
  HL: 'available_for_pickup',
  RS: 'returned',
  RD: 'returned',
  DE: 'exception',
  SE: 'exception',
  CA: 'cancelled',
  DY: 'exception',
};

function toTrackingStatus(derivedCode: string | undefined): TrackingStatus {
  if (!derivedCode) return 'in_transit';
  return DERIVED_CODE_TO_STATUS[derivedCode.toUpperCase()] ?? 'in_transit';
}

/** The shapes this adapter reads. Only the fields actually consumed. */
interface FedexScanEvent {
  date?: string;
  eventType?: string;
  eventDescription?: string;
  derivedStatusCode?: string;
  scanLocation?: {
    city?: string;
    stateOrProvinceCode?: string;
    countryCode?: string;
  };
}

interface FedexDateAndTime {
  type?: string;
  dateTime?: string;
}

export interface FedexTrackResult {
  error?: { code?: string };
  latestStatusDetail?: { code?: string; derivedCode?: string; description?: string };
  scanEvents?: FedexScanEvent[];
  dateAndTimes?: FedexDateAndTime[];
  serviceDetail?: { description?: string };
  shipperInformation?: { address?: { countryCode?: string } };
  recipientInformation?: { address?: { countryCode?: string } };
}

export interface FedexTrackResponse {
  output?: { completeTrackResults?: { trackResults?: FedexTrackResult[] }[] };
}

/**
 * A FedEx timestamp with its offset preserved.
 *
 * FedEx returns ISO-8601 WITH an offset (`2026-09-07T10:04:00-06:00`), so these
 * are true instants and `occurredAtIsLocal` stays false. If a response ever
 * arrives without an offset, that is a fact to report rather than paper over —
 * inventing UTC silently reorders a timeline the moment a parcel crosses a
 * border. Hence the check rather than a bare `new Date()`.
 */
function parseInstant(raw: string | undefined): { at: Date; isLocal: boolean } | null {
  if (!raw) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  return { at, isLocal: !/(Z|[+-]\d{2}:?\d{2})$/.test(raw.trim()) };
}

function toCheckpoint(event: FedexScanEvent): TrackingCheckpointInput | null {
  const parsed = parseInstant(event.date);
  if (!parsed) return null;

  const place = [event.scanLocation?.city, event.scanLocation?.stateOrProvinceCode]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(', ');

  return {
    occurredAt: parsed.at,
    occurredAtIsLocal: parsed.isLocal,
    status: toTrackingStatus(event.derivedStatusCode ?? event.eventType),
    rawStatus: event.derivedStatusCode ?? event.eventType,
    description: event.eventDescription,
    locationText: place.length > 0 ? place : undefined,
    countryCode: event.scanLocation?.countryCode,
  };
}

function pickDate(result: FedexTrackResult, type: string): Date | undefined {
  const match = result.dateAndTimes?.find((entry) => entry.type === type);
  return parseInstant(match?.dateTime)?.at;
}

/**
 * One FedEx track result into one snapshot. PURE — this is the part the tests
 * pin, and the part a recorded live response will confirm or correct.
 */
export function toSnapshot(result: FedexTrackResult): TrackingSnapshot {
  // FedEx reports an unknown number as an error INSIDE a 200, not as a 404.
  // `notFound` rather than a throw: a label created and never scanned is the
  // single most common thing anyone pastes, and treated as a failure it enters
  // error backoff and stays there instead of expiring.
  if (result.error?.code === 'TRACKING.TRACKINGNUMBER.NOTFOUND') {
    return { status: 'pending', checkpoints: [], notFound: true };
  }

  const checkpoints = (result.scanEvents ?? [])
    .map(toCheckpoint)
    .filter((checkpoint): checkpoint is TrackingCheckpointInput => checkpoint !== null)
    // Ascending, which is the order the repository's dedupe and the DTO expect.
    // FedEx returns newest first, and relying on that ordering rather than
    // sorting would put a timeline backwards the day they change it.
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  return {
    status: toTrackingStatus(result.latestStatusDetail?.derivedCode),
    rawStatus: result.latestStatusDetail?.derivedCode ?? result.latestStatusDetail?.code,
    checkpoints,
    estimatedDeliveryAt: pickDate(result, 'ESTIMATED_DELIVERY'),
    deliveredAt: pickDate(result, 'ACTUAL_DELIVERY'),
    serviceName: result.serviceDetail?.description,
    originCountry: result.shipperInformation?.address?.countryCode,
    destinationCountry: result.recipientInformation?.address?.countryCode,
  };
}

/** Dig the single track result out of the envelope, or `null` if absent. */
export function firstTrackResult(body: FedexTrackResponse): FedexTrackResult | null {
  return body.output?.completeTrackResults?.[0]?.trackResults?.[0] ?? null;
}

export interface FedexCredentials {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

/** Refresh this long before the token actually expires. */
const TOKEN_SKEW_MS = 60_000;

export function buildFedexAdapter(credentials: FedexCredentials | null): TrackingAdapter {
  const deepLink = ({ trackingNumber }: { trackingNumber: string }) =>
    DEEP_LINK_TEMPLATE.replace('{number}', encodeURIComponent(trackingNumber));

  const detect = (normalised: string) =>
    /^(\d{12}|\d{15}|\d{20}|\d{22})$/.test(normalised)
      ? { checksumPassed: false, score: 35 }
      : null;

  // No credentials is not a degraded mode — it is the deep-link carrier this
  // build has always shipped, expressed the way the contract expresses it.
  if (!credentials) {
    return {
      key: 'fedex',
      capabilities: { fetch: false, webhook: false, deepLinkOnly: true },
      detect,
      deepLink,
    };
  }

  let cached: { token: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function requestToken(signal: AbortSignal): Promise<string> {
    const response = await fetch(`${credentials.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }),
      signal,
    });

    if (!response.ok) {
      // The status only. A body from an auth endpoint is exactly the thing that
      // must not reach a log.
      throw new Error(`FedEx auth failed with ${response.status}`);
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('FedEx auth returned no access_token');

    cached = {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 - TOKEN_SKEW_MS,
    };
    return cached.token;
  }

  async function getAccessToken(signal: AbortSignal): Promise<string> {
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    // One refresh shared by every caller that arrives while it is open, so a
    // batch of parcels does not open a batch of auth calls.
    inFlight ??= requestToken(signal).finally(() => {
      inFlight = null;
    });
    return await inFlight;
  }

  return {
    key: 'fedex',
    capabilities: { fetch: true, webhook: false, deepLinkOnly: false },
    detect,
    deepLink,
    async fetch(input: TrackingFetchInput): Promise<TrackingSnapshot> {
      const token = await getAccessToken(input.signal);

      const response = await fetch(`${credentials.baseUrl}/track/v1/trackingnumbers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-locale': 'en_US',
        },
        body: JSON.stringify({
          includeDetailedScans: true,
          trackingInfo: [{ trackingNumberInfo: { trackingNumber: input.trackingNumber } }],
        }),
        signal: input.signal,
      });

      if (response.status === 401) {
        // The cached token was rejected. Drop it so the next attempt re-auths,
        // and let the poller's backoff own the retry rather than looping here.
        cached = null;
        throw new Error('FedEx rejected the access token');
      }
      if (!response.ok) {
        throw new Error(`FedEx track failed with ${response.status}`);
      }

      const result = firstTrackResult((await response.json()) as FedexTrackResponse);
      if (!result) {
        log.general.warn(
          { trackingNumber: input.trackingNumber },
          '[Tracking] FedEx returned no track result',
        );
        return { status: 'pending', checkpoints: [], notFound: true };
      }

      return toSnapshot(result);
    },
  };
}
