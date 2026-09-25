// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading a journal off disk, and checking it is one.
 *
 * The journal is JSONL — one event per line — because that is the format a
 * fixture can be reviewed in and a real materializer can append to without
 * rewriting. Every line is validated against its kind's schema on the way in:
 * a runtime that trusts its feed and a runtime that validates it behave
 * identically right up until the feed is wrong, and then only one of them says
 * so.
 *
 * The structural invariants checked here are the ones the runtime depends on
 * and cannot recover from. `seq` increases by exactly one per event, because it
 * is the resume point — a gap means an event was lost and a consumer that
 * resumed past it would never know. It need not start at 1: a journal read from
 * a resume point starts wherever the consumer left off. `observedAt` never
 * moves backwards, because it is processing time. `occurredAt` is free to move
 * backwards, and does: that is a source backfilling, and handling it is the
 * whole reason windowed operators evaluate on semantic time.
 */

import { readFileSync } from "node:fs";

import { journalEventSchema, type JournalEvent } from "./event.js";

export interface JournalProblem {
  /** 1-based line number in the file. */
  readonly line: number;
  readonly message: string;
}

export class JournalFormatError extends Error {
  constructor(
    readonly path: string,
    readonly problems: readonly JournalProblem[],
  ) {
    super(
      `${path} is not a valid journal:\n` +
        problems.map((p) => `  line ${p.line}: ${p.message}`).join("\n"),
    );
    this.name = "JournalFormatError";
  }
}

/** Parse JSONL into events, reporting every problem rather than the first. */
export function parseJournal(text: string, path = "<journal>"): JournalEvent[] {
  /** Each parsed event with the file line it came from, for diagnostics. */
  const parsedEvents: { event: JournalEvent; line: number }[] = [];
  const problems: JournalProblem[] = [];

  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line.length === 0) return;

    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      problems.push({ line: index + 1, message: `not JSON (${(error as Error).message})` });
      return;
    }

    const parsed = journalEventSchema.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push({
          line: index + 1,
          message: `${issue.path.join(".") || "<root>"}: ${issue.message}`,
        });
      }
      return;
    }
    parsedEvents.push({ event: parsed.data, line: index + 1 });
  });

  // Ordering is only meaningful over events that actually parsed. Checking it
  // through a hole would report a cascade of phantom gaps whose real cause is
  // the line that failed above.
  if (problems.length === 0) checkOrdering(parsedEvents, problems);

  if (problems.length > 0) throw new JournalFormatError(path, problems);
  return parsedEvents.map((e) => e.event);
}

function checkOrdering(
  parsed: readonly { event: JournalEvent; line: number }[],
  problems: JournalProblem[],
): void {
  parsed.forEach(({ event, line }, index) => {
    const previous = parsed[index - 1]?.event;
    if (!previous) return;

    const expected = previous.seq + 1;
    if (event.seq !== expected) {
      problems.push({
        line,
        message: `seq is ${event.seq} where ${expected} was expected — the sequence is a resume point, so it advances by exactly one`,
      });
    }
    if (Date.parse(event.observedAt) < Date.parse(previous.observedAt)) {
      problems.push({
        line,
        message: `observedAt moves backwards (${previous.observedAt} then ${event.observedAt}) — processing time only ever advances`,
      });
    }
  });
}

export function readJournal(path: string): JournalEvent[] {
  return parseJournal(readFileSync(path, "utf8"), path);
}
