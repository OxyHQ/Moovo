/**
 * `validateEntityId` accepts both id shapes a Moovo row can have.
 *
 * A primary key is `text` holding a 24-char ObjectId hex for every row that
 * existed before the Postgres cutover and a uuid v7 for every row created
 * after it — both live simultaneously and permanently, because a backfill
 * copies the original id verbatim.
 *
 * This guard was `isValidObjectId`. Left that way, every route behind it would
 * answer 400 for every row created after its domain moved to Postgres: a clean
 * rejection of a perfectly valid id, on the happy path, with no error anywhere
 * to explain it. Nothing else in the suite would have caught that, because
 * every fixture in the repository is still an ObjectId — which is exactly the
 * shape that cannot tell the old check from the new one.
 *
 * So the load-bearing case here is the uuid v7 one, and it is written first.
 */

import type { Request, Response, NextFunction } from 'express';
import { uuidv7 } from '@oxyhq/db';
import { describe, expect, it, vi } from 'vitest';
import { validateEntityId } from '../validate.js';

/** A real ObjectId hex — the shape every pre-cutover row still carries. */
const OBJECT_ID = '507f1f77bcf86cd799439011';

function mockRes(): Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

/** Run the middleware over one param value and report whether it passed. */
function run(value: unknown, paramName = 'id'): { passed: boolean; status: number | undefined } {
  const req = { params: { [paramName]: value } } as unknown as Request;
  const res = mockRes();
  const next = vi.fn() as unknown as NextFunction;
  validateEntityId(paramName)(req, res, next);
  const passed = (next as unknown as ReturnType<typeof vi.fn>).mock.calls.length === 1;
  const status = res.status.mock.calls[0]?.[0] as number | undefined;
  return { passed, status };
}

describe('validateEntityId', () => {
  it('accepts a uuid v7 — the shape every row created after the cutover carries', () => {
    // Ten freshly minted ids rather than one literal: a uuid v7's variant and
    // version nibbles sit at fixed offsets, and a single hard-coded sample
    // could pass a check that happens to accept that one byte pattern.
    for (let i = 0; i < 10; i += 1) {
      expect(run(uuidv7())).toEqual({ passed: true, status: undefined });
    }
  });

  it('still accepts a 24-char ObjectId hex, in either case', () => {
    expect(run(OBJECT_ID).passed).toBe(true);
    expect(run(OBJECT_ID.toUpperCase()).passed).toBe(true);
  });

  it('rejects malformed ids with a 400, so a param cannot carry an arbitrary string', () => {
    // uuid v4 is in the list deliberately: it is the near miss. A guard relaxed
    // to "looks like a uuid" would accept it, and this schema never mints one.
    const rejected = [
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      'not-an-id',
      '507f1f77bcf86cd79943901',
      "1' OR '1",
      '../../etc/passwd',
      '',
    ];
    for (const value of rejected) {
      expect(run(value)).toEqual({ passed: false, status: 400 });
    }
  });

  it('rejects a missing param rather than reading undefined as valid', () => {
    expect(run(undefined)).toEqual({ passed: false, status: 400 });
  });

  it('reads the first value when express hands it an array', () => {
    // Express produces `string[]` when a path repeats a segment name, and a
    // guard that stringified the array instead would compare "a,b".
    expect(run([OBJECT_ID, 'garbage']).passed).toBe(true);
    expect(run(['garbage', OBJECT_ID]).passed).toBe(false);
  });

  it('validates the named param, not always `id`', () => {
    const req = { params: { storeId: OBJECT_ID, id: 'garbage' } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    validateEntityId('storeId')(req, res, next);
    expect((next as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
