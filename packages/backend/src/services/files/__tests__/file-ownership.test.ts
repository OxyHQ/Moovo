/**
 * Who may attach which Oxy file. Runs under vitest AND `bun test`: no module
 * mocks — Oxy's metadata lookup is replaced through the module's own seam.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { rejectionOf } from '../../../__tests__/fixtures/runner-compat';
import { isMoovoError } from '../../../lib/errors/error-codes';
import { ErrorCodes } from '../../../utils/api-response';
import {
  NO_FILE_AUTHORITY,
  assertFilesAttachable,
  fileAuthorityFor,
  setFileMetadataReaderForTesting,
} from '../file-ownership';

interface Fact {
  id: string;
  mime: string;
  status: string;
  ownerUserId?: string | null;
}

const OWNED: Record<string, Fact> = {
  mine: { id: 'mine', mime: 'image/jpeg', status: 'active', ownerUserId: 'me' },
  org: { id: 'org', mime: 'image/png', status: 'active', ownerUserId: 'org-account' },
  theirs: { id: 'theirs', mime: 'image/jpeg', status: 'active', ownerUserId: 'stranger' },
  trashed: { id: 'trashed', mime: 'image/jpeg', status: 'trash', ownerUserId: 'me' },
  video: { id: 'video', mime: 'video/mp4', status: 'active', ownerUserId: 'me' },
  app: { id: 'app', mime: 'image/png', status: 'active', ownerUserId: null },
};

let asked: string[][] = [];

function oxyKnows(facts: Record<string, Fact>): void {
  setFileMetadataReaderForTesting(async (ids) => {
    asked.push(ids);
    return ids.flatMap((id) => (facts[id] ? [facts[id]] : []));
  });
}

const me = { ownerIds: new Set(['me']) };

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await rejectionOf(promise);
  return isMoovoError(error) ? `${error.code}:${error.httpStatus}` : String(error);
}

afterEach(() => {
  asked = [];
  setFileMetadataReaderForTesting();
});

describe('assertFilesAttachable', () => {
  it('accepts the caller’s own active images', async () => {
    oxyKnows(OWNED);
    await assertFilesAttachable(['mine'], me);
    expect(asked).toEqual([['mine']]);
  });

  it('refuses someone else’s file, a missing one, a trashed one and a non-image alike', async () => {
    oxyKnows(OWNED);
    // The same answer for all four: the check must not tell a prober whether
    // an id exists or whose it is.
    for (const id of ['theirs', 'nope', 'trashed', 'video']) {
      expect(await refusal(assertFilesAttachable([id], me))).toBe(
        `${ErrorCodes.VALIDATION_ERROR}:400`,
      );
    }
  });

  it('refuses a file owned by no account (an application’s), which no caller owns', async () => {
    oxyKnows(OWNED);
    expect(await refusal(assertFilesAttachable(['app'], me))).toBe(
      `${ErrorCodes.VALIDATION_ERROR}:400`,
    );
  });

  it('refuses a URL before asking Oxy anything', async () => {
    oxyKnows(OWNED);
    expect(await refusal(assertFilesAttachable(['https://evil.example/pixel.gif'], me))).toBe(
      `${ErrorCodes.VALIDATION_ERROR}:400`,
    );
    expect(asked).toEqual([]);
  });

  it('accepts an account the route authorized the caller to act for', async () => {
    oxyKnows(OWNED);
    await assertFilesAttachable(['org'], { ownerIds: new Set(['me', 'org-account']) });
  });

  it('checks only NEWLY attached ids: a file the row already holds is kept as is', async () => {
    oxyKnows(OWNED);
    await assertFilesAttachable(['theirs', 'mine'], me, ['theirs']);
    expect(asked).toEqual([['mine']]);
    await assertFilesAttachable(['theirs'], me, ['theirs']);
    expect(asked).toEqual([['mine']]);
  });

  it('refuses everything for an authority with no accounts', async () => {
    oxyKnows(OWNED);
    expect(await refusal(assertFilesAttachable(['mine'], NO_FILE_AUTHORITY))).toBe(
      `${ErrorCodes.VALIDATION_ERROR}:400`,
    );
  });

  it('refuses when Oxy does not disclose owners, rather than guessing', async () => {
    oxyKnows({ mine: { id: 'mine', mime: 'image/jpeg', status: 'active' } });
    expect(await refusal(assertFilesAttachable(['mine'], me))).toBe(
      `${ErrorCodes.VALIDATION_ERROR}:400`,
    );
  });

  it('answers 503 when Oxy cannot be asked: never attaches unverified', async () => {
    setFileMetadataReaderForTesting(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await refusal(assertFilesAttachable(['mine'], me))).toBe(
      `${ErrorCodes.INTERNAL_ERROR}:503`,
    );
  });

  it('asks nothing when nothing new is attached', async () => {
    oxyKnows(OWNED);
    await assertFilesAttachable([], me);
    expect(asked).toEqual([]);
  });
});

describe('fileAuthorityFor', () => {
  it('is the session subject, the operator of an operated session, and the accounts named', () => {
    const req = {
      userId: 'org-account',
      user: { id: 'org-account' },
      oxyActor: {
        schemaVersion: 1,
        effectiveAccountId: 'org-account',
        actorAccountId: 'human',
        delegated: true,
      },
    } as unknown as Request;
    expect([...fileAuthorityFor(req, ['fleet']).ownerIds].sort()).toEqual([
      'fleet',
      'human',
      'org-account',
    ]);
  });

  it('is empty for an unauthenticated request', () => {
    expect(fileAuthorityFor({} as Request).ownerIds.size).toBe(0);
  });
});
