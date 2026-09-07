import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * A signed-out visitor's recent tracking numbers, kept ON THEIR DEVICE.
 *
 * Anonymous tracking is a one-off LOOKUP that persists nothing per person: no
 * subscription row, no notification, no socket room, no device identity to
 * hash. That is the whole reason an anonymous parcel costs exactly one carrier
 * call. So "my recent parcels" for a signed-out visitor cannot be a server
 * concept, and lives here instead.
 *
 * Entries are written only AFTER a successful lookup, and carry the number the
 * SERVER returned rather than the string the visitor pasted. That keeps one
 * spelling of the normalisation — the backend's `normalizeTrackingNumber` —
 * instead of a second one drifting on the client, and makes the dedupe below
 * agree with the unique index the parcel identity is built on.
 */

const STORAGE_KEY = 'moovotracker.recents.v1';
const MAX_RECENTS = 12;

export interface RecentLookup {
  /** The canonical number, as the server returned it. */
  trackingNumber: string;
  carrierKey: string;
  carrierName: string;
  /** ISO instant of the last time this visitor looked it up. */
  lastViewedAt: string;
}

function parse(raw: string | null): RecentLookup[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RecentLookup =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as RecentLookup).trackingNumber === 'string',
    );
  } catch {
    // A corrupt or half-written value is answered with an empty list rather
    // than an exception: this is a convenience, and it must never be the reason
    // somebody cannot track a parcel.
    return [];
  }
}

export async function readRecents(): Promise<RecentLookup[]> {
  return parse(await AsyncStorage.getItem(STORAGE_KEY));
}

/** Record a successful lookup, most recent first, deduped by number. */
export async function rememberLookup(
  entry: Omit<RecentLookup, 'lastViewedAt'>,
): Promise<RecentLookup[]> {
  const existing = await readRecents();
  const next: RecentLookup[] = [
    { ...entry, lastViewedAt: new Date().toISOString() },
    ...existing.filter((item) => item.trackingNumber !== entry.trackingNumber),
  ].slice(0, MAX_RECENTS);

  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export async function forgetLookup(trackingNumber: string): Promise<RecentLookup[]> {
  const next = (await readRecents()).filter(
    (item) => item.trackingNumber !== trackingNumber,
  );
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
