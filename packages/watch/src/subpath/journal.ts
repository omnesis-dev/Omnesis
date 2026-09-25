// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/watch/journal` — the event contract, and nothing else.
 *
 * A producer of the journal needs the shapes it has to write and the parser
 * that refuses anything else. It does not need the DSL, the validator, the
 * evaluation engine, the backtest harness, the compiler, or the fixture
 * universe those are proven against — and importing the package root would
 * evaluate every one of them, because ESM has no runtime tree-shaking. The
 * gateway's materializer is exactly that producer, and it runs in every
 * gateway process whether or not the subsystem is switched on.
 *
 * So the contract lives behind its own subpath: the producer imports the
 * agreement, not the implementation on the other side of it.
 */

export {
  JOURNAL_EVENT_KINDS,
  isKind,
  journalEventSchema,
  toJournalInstant,
  type AnalyticsRowEvent,
  type DocEvent,
  type DocIndexedEvent,
  type JournalEvent,
  type JournalEventKind,
  type LoopEvent,
  type LoopSnapshot,
  type PersonMention,
  type TimerFiredEvent,
} from "../journal/event.js";
