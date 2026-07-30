/**
 * The loop that drains the moderation outbox.
 *
 * Runs on EVERY task, not on a leader. Claims are Mongo leases with an owner
 * check, so N tasks share the work safely and a dead task's lease is reclaimed
 * once it expires — leader election would add a failure mode (no leader, no
 * moderation) for no benefit the lease does not already provide.
 *
 * No-ops when `CROWDSOURCE_ENABLED=false`. The LOOP is what is gated, never the
 * durable record: reports taken while the integration is off keep their outbox
 * rows and deliver when it is switched on.
 */

import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { applyDecisionOutboxEvent } from './moderation-decision.worker.js';
import { deliverReportOutboxEvent } from './moderation-delivery.worker.js';
import {
  dispatchModerationOutbox,
  type ModerationOutboxEvent,
} from './moderation-outbox.service.js';

let timer: NodeJS.Timeout | null = null;
let controller: AbortController | null = null;
let inFlight: Promise<void> | null = null;

/** Route one event to the handler for its kind. */
async function handleEvent(event: ModerationOutboxEvent): Promise<void> {
  switch (event.kind) {
    case 'report.submit':
      await deliverReportOutboxEvent(event);
      return;
    case 'decision.apply':
      await applyDecisionOutboxEvent(event);
      return;
    default:
      /**
       * A kind this build does not know, from a row an older or newer deployment
       * wrote. Thrown rather than ignored: completing it would retire work this
       * process cannot do, and the outbox will retry it until a build that
       * understands it picks it up.
       */
      throw new Error(`Unknown moderation outbox kind: ${String(event.kind)}`);
  }
}

async function runOnce(signal: AbortSignal): Promise<void> {
  try {
    const result = await dispatchModerationOutbox({
      handler: handleEvent,
      batchSize: config.crowdSource.outboxBatchSize,
      signal,
    });
    if (result.processed > 0 || result.failed > 0) {
      log.moderation.debug(result, '[ModerationOutbox] batch complete');
    }
  } catch (error: unknown) {
    // The loop must survive anything a batch throws — an unhandled rejection here
    // would stop moderation delivery for the life of the process.
    log.moderation.error({ err: error }, '[ModerationOutbox] dispatch batch failed');
  }
}

export function startModerationOutboxDispatcher(): void {
  if (timer !== null) return;
  if (!config.crowdSource.enabled) {
    log.moderation.info('[ModerationOutbox] dispatcher not started: CrowdSource is disabled');
    return;
  }

  controller = new AbortController();
  const signal = controller.signal;

  timer = setInterval(() => {
    // One batch at a time per task: overlapping runs would double the claim
    // pressure without draining faster, since claims are serialised in Mongo.
    if (inFlight) return;
    inFlight = runOnce(signal).finally(() => {
      inFlight = null;
    });
  }, config.crowdSource.outboxPollIntervalMs);
  // A housekeeping interval must never hold the event loop open.
  timer.unref?.();

  log.moderation.info(
    { intervalMs: config.crowdSource.outboxPollIntervalMs },
    '[ModerationOutbox] dispatcher started',
  );
}

/** Stop claiming new work and let the batch in flight reach a durable state. */
export async function stopModerationOutboxDispatcher(): Promise<void> {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  controller?.abort();
  controller = null;
  await inFlight;
}
