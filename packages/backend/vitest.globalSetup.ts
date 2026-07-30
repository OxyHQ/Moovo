import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * One MongoDB replica set for the whole suite.
 *
 * A replica SET rather than a standalone, because the two properties the
 * moderation integration rests on only exist there: multi-document transactions
 * (a report and its outbox row commit together, or neither does) and the unique
 * indexes that make a retry idempotent.
 *
 * The reason this is a real server and not a mocked model is specific and was
 * paid for elsewhere in this ecosystem: **a mocked `updateOne` accepts every
 * update document, including ones the server rejects.** An update naming a path
 * in two operators at once — say `updatedAt` in both `$set` and `$setOnInsert`,
 * which `{ timestamps: true }` causes on an upsert — is refused by Mongo with
 * `MongoServerError: Updating the path 'updatedAt' would create a conflict`, and
 * inside a transaction that abort takes the report row with it. Against a mock,
 * every test still passes while `POST /reports` fails for every caller from the
 * first one. Coverage cannot see it either: it measures which lines ran, not
 * whether the server would accept what they produced.
 *
 * So the mutation evidence for the transaction-coupling invariant is only worth
 * anything when it is produced here.
 */
let replicaSet: MongoMemoryReplSet | null = null;

export async function setup(): Promise<void> {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env.MOOVO_TEST_MONGODB_URI = replicaSet.getUri();
}

export async function teardown(): Promise<void> {
  await replicaSet?.stop();
  replicaSet = null;
}
