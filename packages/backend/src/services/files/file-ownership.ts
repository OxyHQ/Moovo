/**
 * Who may attach which Oxy file to a Moovo row.
 *
 * Before this, every `fileId` a client sent was stored as given: a listing
 * could show a stranger's photo, a courier's proof of delivery could be
 * somebody else's picture, and — because the media resolver passed URLs
 * through — any field could hotlink any server. A file id is a capability
 * only if Moovo checks it, and Oxy is the only party that knows who owns a
 * file: `assets.metadataByIds` discloses `ownerUserId` to Oxy's own
 * applications (service tokens with `tier: 'internal'`, which Moovo's is).
 *
 * The rule (oxy ADR 0043 D4, from the app's side): a NEWLY attached file must
 * be active, an image, and owned by an account the caller is — the session's
 * subject, or the human operating it — or by an account the route has already
 * authorized the caller to act for (a fleet's organization account). Ids the
 * row already holds are not re-checked, so an editor may keep a logo another
 * administrator chose.
 *
 * Every write path that accepts a file id takes a {@link FileAuthority}, so a
 * new path cannot store one without deciding whose files it may use.
 */

import type { Request } from 'express';
import { getOxyActor, getOxyUserId } from '@oxy.so/core/server';
import { oxyClient } from '../../middleware/auth.js';
import { MoovoError, validationError } from '../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../utils/api-response.js';
import { log } from '../../lib/logger.js';
import { isOxyFileId } from '../media.service.js';

/** The accounts whose files a write may attach. */
export interface FileAuthority {
  readonly ownerIds: ReadonlySet<string>;
}

/**
 * The caller's accounts — the session's subject and, on an operated session,
 * the operator — plus any account the route has ALREADY authorized the caller
 * to act for. Never derived from a header or a body field.
 */
export function fileAuthorityFor(req: Request, actingFor: readonly string[] = []): FileAuthority {
  const ownerIds = new Set<string>();
  const subject = getOxyUserId(req);
  if (subject) ownerIds.add(subject);
  const actor = getOxyActor(req);
  if (actor?.actorAccountId) ownerIds.add(actor.actorAccountId);
  for (const id of actingFor) if (id) ownerIds.add(id);
  return { ownerIds };
}

/** An authority for an internal write that must not attach anybody's file. */
export const NO_FILE_AUTHORITY: FileAuthority = Object.freeze({ ownerIds: new Set<string>() });

/** The `metadataByIds` view this check needs. */
interface FileFacts {
  id: string;
  mime: string;
  status: string;
  ownerUserId?: string | null;
}

type MetadataReader = (ids: string[]) => Promise<FileFacts[]>;

let readMetadata: MetadataReader = (ids) => oxyClient.assets.metadataByIds(ids);

/** Test seam: replace Oxy's metadata lookup. Pass nothing to restore it. */
export function setFileMetadataReaderForTesting(reader?: MetadataReader): void {
  readMetadata = reader ?? ((ids) => oxyClient.assets.metadataByIds(ids));
}

const REFUSED_MESSAGE =
  'One or more files cannot be attached: each must be an image you uploaded to Oxy';

/**
 * Refuse unless every id in `fileIds` that is not in `alreadyAttached` is an
 * active Oxy image owned by one of `authority.ownerIds`.
 *
 * "Missing", "not an image" and "someone else's" answer identically, so the
 * check cannot be used to learn whether an id exists or whose it is. When Oxy
 * cannot be asked, the write is refused (503) — attaching unverified is the
 * failure this exists to remove.
 */
export async function assertFilesAttachable(
  fileIds: readonly string[],
  authority: FileAuthority,
  alreadyAttached: readonly string[] = [],
): Promise<void> {
  const kept = new Set(alreadyAttached);
  const added = [...new Set(fileIds)].filter((id) => !kept.has(id));
  if (added.length === 0) return;

  if (!added.every(isOxyFileId)) throw validationError(REFUSED_MESSAGE);
  if (authority.ownerIds.size === 0) throw validationError(REFUSED_MESSAGE);

  let facts: FileFacts[];
  try {
    facts = await readMetadata(added);
  } catch (error: unknown) {
    log.general.warn({ err: error, count: added.length }, '[Files] ownership lookup failed');
    throw new MoovoError({
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Files cannot be verified right now; try again shortly',
      httpStatus: 503,
      cause: error,
    });
  }

  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  for (const id of added) {
    const fact = byId.get(id);
    if (fact && fact.ownerUserId === undefined) {
      // Oxy discloses owners only to its own applications. Without it there
      // is nothing to check against, and guessing would re-open the hole —
      // so this is loud rather than permissive.
      log.general.error(
        '[Files] Oxy did not disclose file owners: is this service token internal-tier?',
      );
    }
    if (
      fact?.status !== 'active' ||
      !fact.mime.startsWith('image/') ||
      typeof fact.ownerUserId !== 'string' ||
      !authority.ownerIds.has(fact.ownerUserId)
    ) {
      throw validationError(REFUSED_MESSAGE);
    }
  }
}
