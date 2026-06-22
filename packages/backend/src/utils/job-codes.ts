/**
 * QR pickup/delivery proof codes (PURE — no I/O).
 *
 * Each booked Moovo-courier job has two single-use codes: a PICKUP code the
 * sender shows the courier at collection, and a DROPOFF code the recipient shows
 * the courier at delivery. The job stores the SHA-256 hash of each code as the
 * verify source; the courier never sees the plaintext — they scan the sender's /
 * recipient's QR and the backend verifies the scanned code against the stored
 * hash. The plaintext is surfaced ONLY in owner-scoped (sender) DTOs.
 *
 * The QR payload is a stable, namespaced, parseable string so a generic QR
 * scanner can carry it and the backend can route it: `moovo:job:<jobId>:<leg>:<code>`.
 * `verifyCode` is constant-time over equal-length buffers and never throws on a
 * malformed input — a length mismatch returns `false`, never an exception.
 */

import crypto from 'crypto';

/** Bytes of entropy per code; 16 bytes → 32 hex chars (128 bits). */
export const CODE_BYTES = 16;

/** Namespace prefix of the QR payload (so a scanner/router can recognise it). */
export const QR_PREFIX = 'moovo:job:';

/** The two legs a code can prove. */
export type ScanLeg = 'pickup' | 'dropoff';

/** A parsed QR payload. */
export interface DecodedQrPayload {
  /** The job the code belongs to. */
  jobId: string;
  /** Which leg the code proves. */
  leg: ScanLeg;
  /** The plaintext code. */
  code: string;
}

/** Generate a fresh random code (hex). */
export function generateCode(): string {
  return crypto.randomBytes(CODE_BYTES).toString('hex');
}

/** Hash a code with SHA-256, returning lowercase hex. */
export function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Whether `code` hashes to `expectedHash`. Constant-time over the equal-length
 * hex digests; returns `false` (never throws) when either input is malformed or
 * the digest lengths differ.
 */
export function verifyCode(code: string, expectedHash: string): boolean {
  if (typeof code !== 'string' || typeof expectedHash !== 'string' || expectedHash.length === 0) {
    return false;
  }
  const actual = Buffer.from(hashCode(code), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length || actual.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

/** Whether a value is one of the two valid scan legs. */
function isScanLeg(value: string): value is ScanLeg {
  return value === 'pickup' || value === 'dropoff';
}

/** Build the QR payload string for a job leg: `moovo:job:<jobId>:<leg>:<code>`. */
export function encodeQrPayload(jobId: string, leg: ScanLeg, code: string): string {
  return `${QR_PREFIX}${jobId}:${leg}:${code}`;
}

/**
 * Parse a QR payload back into its parts. Returns `null` on any malformed input
 * (wrong prefix, missing parts, unknown leg) — never throws. The code component
 * is the final segment, so a code containing no separators round-trips cleanly.
 */
export function decodeQrPayload(payload: string): DecodedQrPayload | null {
  if (typeof payload !== 'string' || !payload.startsWith(QR_PREFIX)) {
    return null;
  }
  const rest = payload.slice(QR_PREFIX.length);
  const firstSep = rest.indexOf(':');
  if (firstSep <= 0) {
    return null;
  }
  const jobId = rest.slice(0, firstSep);
  const afterJob = rest.slice(firstSep + 1);
  const secondSep = afterJob.indexOf(':');
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
