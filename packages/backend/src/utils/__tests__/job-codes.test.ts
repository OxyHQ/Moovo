/**
 * Unit tests for the pure QR job-code helpers.
 *
 * Covers: generate → hash → verify roundtrip; `verifyCode` returns false on the
 * wrong code; `verifyCode` is safe (returns false, never throws) on unequal /
 * malformed inputs; and the QR payload encode → decode roundtrip (including a
 * code that itself contains the separator, malformed payloads, unknown legs).
 */

import { describe, it, expect } from 'vitest';
import {
  CODE_BYTES,
  QR_PREFIX,
  generateCode,
  hashCode,
  verifyCode,
  encodeQrPayload,
  decodeQrPayload,
} from '../job-codes.js';

describe('job-codes — generate/hash/verify', () => {
  it('a generated code is 2× CODE_BYTES hex chars', () => {
    const code = generateCode();
    expect(code).toMatch(/^[0-9a-f]+$/);
    expect(code).toHaveLength(CODE_BYTES * 2);
  });

  it('generates distinct codes', () => {
    expect(generateCode()).not.toBe(generateCode());
  });

  it('round-trips generate → hash → verify (true on the right code)', () => {
    const code = generateCode();
    const hash = hashCode(code);
    expect(verifyCode(code, hash)).toBe(true);
  });

  it('verify is false on the wrong code', () => {
    const hash = hashCode(generateCode());
    expect(verifyCode(generateCode(), hash)).toBe(false);
  });

  it('verify is false (never throws) on an empty / malformed expected hash', () => {
    const code = generateCode();
    expect(verifyCode(code, '')).toBe(false);
    expect(verifyCode(code, 'not-hex-and-wrong-length')).toBe(false);
  });

  it('verify is false (never throws) when digest lengths differ', () => {
    const code = generateCode();
    // A valid-hex but short string → unequal buffer length → false, not a throw.
    expect(verifyCode(code, 'abcd')).toBe(false);
  });
});

describe('job-codes — QR payload encode/decode', () => {
  it('round-trips encode → decode for both legs', () => {
    const code = generateCode();
    for (const leg of ['pickup', 'dropoff'] as const) {
      const payload = encodeQrPayload('job-123', leg, code);
      expect(payload.startsWith(QR_PREFIX)).toBe(true);
      const decoded = decodeQrPayload(payload);
      expect(decoded).toEqual({ jobId: 'job-123', leg, code });
    }
  });

  it('decodes a code that itself contains the separator (final-segment parse)', () => {
    const code = 'aa:bb:cc';
    const payload = encodeQrPayload('job-x', 'dropoff', code);
    expect(decodeQrPayload(payload)).toEqual({ jobId: 'job-x', leg: 'dropoff', code });
  });

  it('returns null on a wrong prefix', () => {
    expect(decodeQrPayload('other:job:j:pickup:code')).toBeNull();
  });

  it('returns null on a missing part', () => {
    expect(decodeQrPayload(`${QR_PREFIX}only-job-id`)).toBeNull();
    expect(decodeQrPayload(`${QR_PREFIX}job:pickup`)).toBeNull();
  });

  it('returns null on an unknown leg', () => {
    expect(decodeQrPayload(`${QR_PREFIX}job:sideways:code`)).toBeNull();
  });

  it('returns null on an empty code', () => {
    expect(decodeQrPayload(`${QR_PREFIX}job:pickup:`)).toBeNull();
  });
});
