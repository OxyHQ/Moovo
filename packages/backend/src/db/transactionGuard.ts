/**
 * The port of `moderation-outbox.service.ts`'s transaction assertion.
 *
 * The outbox row IS the durable promise that a piece of moderation work will
 * happen, and it is only durable if it commits in the SAME transaction as the
 * domain write that owed it. Written outside one, the row still appears, every
 * test that asserts "the row exists" still passes, and the invariant the whole
 * collection exists for is silently gone — a report can be stored while the
 * promise to deliver it is not, or the reverse.
 *
 * The source states this as `if (!session.inTransaction()) throw`. Mongoose
 * offers that because a session knows whether a transaction is open; drizzle
 * offers no equivalent, so the guard has to discriminate the handle itself.
 *
 * ## Why a TYPE cannot do this
 *
 * `DatabaseOrTransaction` is a union, and the root `Database` satisfies it.
 * So a caller that simply forgets to pass the transaction handle — writing
 * `insertOutboxRow(getDb(), …)` inside a `db.transaction(...)` block — type
 * checks perfectly, commits on its own connection, outside the caller's
 * transaction, and rolls back with nothing. There is no type that refuses it,
 * because both operands are legitimately of that type.
 *
 * What separates them at RUNTIME is that only a transaction handle carries a
 * `.rollback` method. That is the discriminator, and it is why this guard is a
 * function rather than a signature.
 */

import type { Database, DatabaseOrTransaction, Transaction } from './postgres';

/**
 * Narrow a handle to a real transaction, or refuse.
 *
 * Callers whose write must be atomic with the caller's own take this instead
 * of `DatabaseOrTransaction`, so "this must run in a transaction" is enforced
 * where the write happens rather than documented above it.
 */
export function requireTransaction(db: DatabaseOrTransaction, operation: string): Transaction {
  if (!isTransaction(db)) {
    throw new Error(
      `${operation} must run inside a transaction, and was handed the root connection. ` +
        'The row it writes is only durable if it commits with the domain write that ' +
        'owed it — written on its own connection it commits alone, which looks ' +
        'identical in every test that only asserts the row exists.',
    );
  }
  return db;
}

/**
 * Whether this handle is a transaction rather than the root connection.
 *
 * `rollback` is the discriminator because it is the one member a transaction
 * has and the root pool handle does not — the root has nothing to roll back.
 */
function isTransaction(db: DatabaseOrTransaction): db is Transaction {
  return typeof (db as Partial<Transaction>).rollback === 'function';
}

/**
 * The inverse, for the few callers that legitimately need the ROOT handle —
 * a background sweep must not silently enlist in somebody's transaction and
 * hold it open for the duration of a batch.
 */
export function isRootConnection(db: DatabaseOrTransaction): db is Database {
  return !isTransaction(db);
}
