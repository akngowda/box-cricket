/**
 * Replay — the scoreboard is always derived, never stored (02-ARCHITECTURE §1).
 *
 * Undo (R7d) is "void the last delivery, then replay": nothing is ever mutated
 * in place, so a voided ball simply stops contributing.
 */

import { applyDelivery, applyEvent, createInnings, type CreateInningsOptions } from './engine';
import type {
  DeliveryResult,
  InningsState,
  MatchEvent,
  RulesConfig,
  StoredDelivery,
} from './types';

/** One entry of the innings timeline, in commit order. */
export type TimelineEntry =
  | { kind: 'delivery'; delivery: StoredDelivery }
  | { kind: 'event'; seq: number; event: MatchEvent };

export interface ReplayOutput {
  state: InningsState;
  /** One result per non-voided delivery, in order — this is the commentary. */
  results: DeliveryResult[];
}

/** Replay a bare delivery log. */
export function replayInnings(
  deliveries: readonly StoredDelivery[],
  rules: RulesConfig,
  init: CreateInningsOptions,
): ReplayOutput {
  return replayTimeline(
    deliveries.map((d) => ({ kind: 'delivery' as const, delivery: d })),
    rules,
    init,
  );
}

/** Replay deliveries and match_events together, ordered by seq. */
export function replayTimeline(
  timeline: readonly TimelineEntry[],
  rules: RulesConfig,
  init: CreateInningsOptions,
): ReplayOutput {
  const ordered = [...timeline].sort((a, b) => seqOf(a) - seqOf(b));

  let state = createInnings(init);
  const results: DeliveryResult[] = [];

  for (const entry of ordered) {
    if (entry.kind === 'event') {
      state = applyEvent(state, entry.event, rules);
      continue;
    }
    // Voided balls never happened, but the row survives for the audit trail.
    if (entry.delivery.isVoided) continue;
    const { state: next, result } = applyDelivery(state, entry.delivery, rules);
    state = next;
    results.push(result);
  }

  return { state, results };
}

function seqOf(e: TimelineEntry): number {
  return e.kind === 'delivery' ? e.delivery.seq : e.seq;
}

/**
 * R7d — void the last live delivery. Returns the new log; the caller replays it.
 * Nothing is deleted (02-ARCHITECTURE §4: deliveries have no DELETE path).
 */
export function voidLastDelivery(deliveries: readonly StoredDelivery[]): StoredDelivery[] {
  const out = deliveries.map((d) => ({ ...d }));
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const d = out[i] as StoredDelivery;
    if (!d.isVoided) {
      d.isVoided = true;
      break;
    }
  }
  return out;
}
