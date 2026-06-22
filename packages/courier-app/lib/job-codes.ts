/**
 * QR pickup/delivery proof codes (PURE — no I/O).
 *
 * Mirrors the backend's `packages/backend/src/utils/job-codes.ts` encoding so the
 * courier app can decode the QR a sender/recipient shows. The payload is a
 * stable, namespaced string: `moovo:job:<jobId>:<leg>:<code>`. The courier never
 * sees the plaintext code ahead of time — they scan the QR, we extract the
 * `code`, and the backend verifies it against the job's stored hash.
 */

/** Namespace prefix of the QR payload (matches the backend `QR_PREFIX`). */
export const QR_PREFIX = "moovo:job:";

/** The two legs a code can prove. */
export type ScanLeg = "pickup" | "dropoff";

/** A decoded QR payload. */
export interface DecodedQrPayload {
  /** The job the code belongs to. */
  jobId: string;
  /** Which leg the code proves. */
  leg: ScanLeg;
  /** The plaintext code. */
  code: string;
}

function isScanLeg(value: string): value is ScanLeg {
  return value === "pickup" || value === "dropoff";
}

/**
 * Parse a QR payload back into its parts. Returns `null` on any malformed input
 * (wrong prefix, missing parts, unknown leg) — never throws. The code component
 * is the final segment, so a code containing no separators round-trips cleanly.
 * This is a faithful port of the backend `decodeQrPayload`.
 */
export function decodeQrPayload(payload: string): DecodedQrPayload | null {
  if (typeof payload !== "string" || !payload.startsWith(QR_PREFIX)) {
    return null;
  }
  const rest = payload.slice(QR_PREFIX.length);
  const firstSep = rest.indexOf(":");
  if (firstSep <= 0) {
    return null;
  }
  const jobId = rest.slice(0, firstSep);
  const afterJob = rest.slice(firstSep + 1);
  const secondSep = afterJob.indexOf(":");
  if (secondSep <= 0) {
    return null;
  }
  const leg = afterJob.slice(0, secondSep);
  const code = afterJob.slice(secondSep + 1);
  if (!isScanLeg(leg) || code.length === 0) {
    return null;
  }
  return { jobId, leg, code };
}
