// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ToolContext } from "../backend.js";
import type { DocumentPortResult } from "./types.js";

export type CitationReadResolution =
  | { ok: true; quote?: string }
  | {
      ok: false;
      reason:
        | "unread"
        | "changed"
        | "quote_required"
        | "body_unavailable"
        | "quote_mismatch"
        | "quote_ambiguous";
      full: boolean;
    };

/** Evidence exposure, never semantic verification. Bounded eviction requires a fresh read. */
export class CitationReads {
  private readonly reads = new Map<
    string,
    {
      version: string;
      fullPageAuthorityVersion?: string;
      full: boolean;
      spans: { offset: number; length: number }[];
    }
  >();

  constructor(private readonly limit = 512) {}

  private key(ctx: ToolContext, id: string): string {
    return JSON.stringify([ctx.sessionId, ctx.messageId, id]);
  }

  /** Version/range receipts only; callers must recheck authorization and version. */
  snapshot(ctx: ToolContext): Array<{
    documentId: string;
    version: string;
    fullPageAuthorityVersion?: string;
    full: boolean;
    spans: { offset: number; length: number }[];
  }> {
    const result = [];
    for (const [key, value] of this.reads) {
      const [sessionId, messageId, documentId] = JSON.parse(key) as string[];
      if (sessionId === ctx.sessionId && messageId === ctx.messageId)
        result.push({
          documentId: documentId!,
          ...value,
          spans: value.spans.map((span) => ({ ...span })),
        });
    }
    return result;
  }

  record(
    ctx: ToolContext,
    result: DocumentPortResult,
    full: boolean,
    span?: { offset: number; length: number },
  ): void {
    const snapshot = result.readSnapshot;
    if (!snapshot) return;
    const key = this.key(ctx, snapshot.documentId);
    const prior = this.reads.get(key);
    const same = prior?.version === snapshot.version;
    const spans = full
      ? []
      : [...(same ? (prior?.spans ?? []) : []), ...(span ? [span] : [])].slice(-2);
    this.reads.delete(key);
    this.reads.set(key, {
      version: snapshot.version,
      ...(full && snapshot.fullPageAuthorityVersion
        ? { fullPageAuthorityVersion: snapshot.fullPageAuthorityVersion }
        : same && prior?.fullPageAuthorityVersion
          ? { fullPageAuthorityVersion: prior.fullPageAuthorityVersion }
          : {}),
      full: full || (same && prior?.full === true),
      spans,
    });
    while (this.reads.size > this.limit) this.reads.delete(this.reads.keys().next().value!);
  }

  resolve(ctx: ToolContext, result: DocumentPortResult, quote?: string): { quote?: string } | null {
    const resolution = this.resolveDetailed(ctx, result, quote);
    return resolution.ok
      ? resolution.quote === undefined
        ? {}
        : { quote: resolution.quote }
      : null;
  }

  /** Closed recovery reasons; callers must authorize the fresh document first. */
  resolveDetailed(
    ctx: ToolContext,
    result: DocumentPortResult,
    quote?: string,
  ): CitationReadResolution {
    const snapshot = result.readSnapshot;
    if (!snapshot) return { ok: false, reason: "unread", full: false };
    const read = this.reads.get(this.key(ctx, snapshot.documentId));
    if (!read) return { ok: false, reason: "unread", full: false };
    if (read.version !== snapshot.version) return { ok: false, reason: "changed", full: false };
    if (read.full && quote === undefined) return { ok: true };
    if (!quote)
      return {
        ok: false,
        reason: read.full ? "quote_mismatch" : "quote_required",
        full: read.full,
      };
    const document = result.document;
    if (
      !document ||
      typeof document !== "object" ||
      !("content" in document) ||
      typeof document.content !== "string"
    )
      return { ok: false, reason: "body_unavailable", full: read.full };
    const content = document.content;
    const spans = read.full ? [{ offset: 0, length: content.length }] : read.spans;
    if (spans.some((span) => content.slice(span.offset, span.offset + span.length).includes(quote)))
      return { ok: true, quote };
    const matches = new Map<number, string>();
    for (const span of spans) {
      for (const match of whitespaceMatches(
        content.slice(span.offset, span.offset + span.length),
        quote,
      )) {
        matches.set(span.offset + match.offset, match.text);
        if (matches.size > 1) return { ok: false, reason: "quote_ambiguous", full: read.full };
      }
    }
    return matches.size === 1
      ? { ok: true, quote: matches.values().next().value! }
      : { ok: false, reason: "quote_mismatch", full: read.full };
  }
}

/** Whitespace equivalence only; return literal source offsets, never rewritten prose. */
function whitespaceMatches(content: string, quote: string): { offset: number; text: string }[] {
  const needle = quote.replace(/\s+/gu, " ").trim();
  if (!needle) return [];
  const normalized = content.replace(/\s+/gu, " ");
  const start = normalized.indexOf(needle);
  if (start < 0) return [];
  // Two matches are enough to reject ambiguity; do not collect an unbounded list.
  const second = normalized.indexOf(needle, start + 1);
  const wanted = second < 0 ? [start] : [start, second];
  const results: { offset: number; text: string }[] = [];
  let sourceOffset = 0;
  let normalizedOffset = 0;
  for (const at of wanted) {
    while (normalizedOffset < at) {
      sourceOffset = nextNormalizedCharacter(content, sourceOffset);
      normalizedOffset++;
    }
    const from = sourceOffset;
    let end = from;
    for (let i = 0; i < needle.length; i++) {
      end = nextNormalizedCharacter(content, end);
    }
    results.push({ offset: from, text: content.slice(from, end) });
  }
  return results;
}

function nextNormalizedCharacter(content: string, offset: number): number {
  if (!/\s/u.test(content[offset] ?? "")) return offset + 1;
  do offset++;
  while (offset < content.length && /\s/u.test(content[offset]!));
  return offset;
}
