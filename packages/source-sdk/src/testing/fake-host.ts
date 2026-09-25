// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A host for a source under test.
 *
 * One of the reasons the old arrangement was worth changing: testing a source
 * meant faking a gateway, which is an interface of roughly forty methods, so
 * the test that would have caught the bug did not get written. What a source
 * needs is small enough that a fake fits in a few lines — and small enough
 * that this helper can supply sensible defaults for all of it.
 *
 * The clock is frozen by default. A source with time-dependent behaviour — a
 * backoff window, a day boundary, a staleness check — is then driven
 * deterministically instead of racing the wall clock.
 */

import type { Logger } from "@omnesis/core";
import type { ProviderHost, SourceAnalyticsAccess, SourceHost } from "../source-host.js";

/** A logger that records instead of printing, so a test can assert on it. */
export interface RecordingLogger extends Logger {
  readonly lines: ReadonlyArray<{ level: "debug" | "info" | "warn" | "error"; message: string }>;
}

export function recordingLogger(): RecordingLogger {
  const lines: Array<{ level: "debug" | "info" | "warn" | "error"; message: string }> = [];
  const make = (level: "debug" | "info" | "warn" | "error") => (message: string) => {
    lines.push({ level, message });
  };
  const logger: RecordingLogger = {
    lines,
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    child: () => logger,
  };
  return logger;
}

/**
 * Analytics reads, for a source that enriches what it already stored.
 *
 * There is nothing here for writes, because a source has nowhere to write
 * except its page — so a test asserts on what the page says, which is also
 * what the host will act on.
 */
export interface FakeAnalytics extends SourceAnalyticsAccess {
  /** Every query the source ran, in order. */
  readonly queries: readonly string[];
  /**
   * Queue the rows the next query should return.
   *
   * One answer per query: a source that queries twice in a phase gets the
   * queued rows once and an empty result after, which is what an exhausted
   * upstream looks like. Call it again between the two to answer both.
   */
  answerWith(rows: Record<string, unknown>[]): void;
}

export function fakeAnalytics(): FakeAnalytics {
  const queries: string[] = [];
  let queued: Record<string, unknown>[] = [];
  return {
    queries,
    answerWith(rows) {
      queued = rows;
    },
    query(sql) {
      queries.push(sql);
      const rows = queued;
      queued = [];
      return Promise.resolve({ columns: Object.keys(rows[0] ?? {}), rows });
    },
  };
}

export interface FakeHostOptions {
  /** Defaults to a temp-shaped path; supply a real one when the source writes. */
  stateDir?: string;
  configDir?: string;
  /** Frozen unless supplied, so time-dependent behaviour is deterministic. */
  now?: Date | (() => Date);
  log?: Logger;
  ingestion?: ProviderHost["ingestion"];
  extractAttachment?: ProviderHost["extractAttachment"];
  transcribeAudio?: SourceHost["transcribeAudio"];
  includeAudioTypes?: boolean;
  /** Pass `fakeAnalytics()` for a source that declares tables. */
  analytics?: SourceAnalyticsAccess;
}

/** Account-scoped services, for testing a provider's shared context. */
export function fakeProviderHost(options: FakeHostOptions = {}): ProviderHost {
  const now = options.now;
  return {
    log: options.log ?? recordingLogger(),
    now: typeof now === "function" ? now : () => now ?? new Date("2026-01-01T00:00:00.000Z"),
    stateDir: options.stateDir ?? "/tmp/omnesis-test/provider/account",
    configDir: options.configDir ?? "/tmp/omnesis-test",
    ingestion: options.ingestion,
    extractAttachment: options.extractAttachment,
  };
}

/** Source-scoped services, for testing a live instance. */
export function fakeSourceHost(options: FakeHostOptions = {}): SourceHost {
  return {
    ...fakeProviderHost(options),
    transcribeAudio: options.transcribeAudio,
    includeAudioTypes: options.includeAudioTypes ?? false,
    analytics: options.analytics,
  };
}
