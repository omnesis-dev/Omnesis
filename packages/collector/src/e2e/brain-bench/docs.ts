// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The bench's document builders and arc kits.
 *
 * Universes carry only an ambient corpus — they have no timeline mechanism
 * — so anything that must ARRIVE during a test is pushed through the
 * harness. An **arc kit** keeps that stimulus together with the behavior
 * the puppet steward should enact for it, because the two only make sense
 * as a pair: a document that is never reacted to proves nothing, and a
 * behavior with no document to fire on never runs.
 *
 * Everything here is invented from scratch — fictional people on RFC-2606
 * reserved domains, fictional vendors and places, reserved-range phone
 * numbers. Nothing derives from any real corpus.
 */

import { call } from "./puppet-plan.js";
import type { BenchDoc } from "./bench.js";

// ── the invented cast ───────────────────────────────────────────────────────

/**
 * The people the default universe (`loops-test-life`) already knows.
 *
 * These addresses must match the universe's own fixtures exactly: an actor
 * named by a different address does not fail — it silently MINTS a second
 * person, and the resulting test failure reads as a person-resolution bug in
 * the gateway rather than a typo in the fixture.
 */
export const CAST = {
  self: { name: "Alex Rivera", email: "alex.rivera@example.com" },
  maya: { name: "Maya Reeves", email: "maya.reeves@example.org" },
  jamie: { name: "Jamie Lopez", email: "jamie.lopez@example.com" },
} as const;

// ── document builders ───────────────────────────────────────────────────────

export function email(doc: Partial<BenchDoc> & { externalId: string; title: string }): BenchDoc {
  return {
    documentType: "email",
    content: doc.content ?? `Message body for ${doc.title}.`,
    ...doc,
  };
}

export function note(doc: Partial<BenchDoc> & { externalId: string; title: string }): BenchDoc {
  return {
    documentType: "document",
    content: doc.content ?? `Note body for ${doc.title}.`,
    ...doc,
  };
}

/** A document the user explicitly addressed to the agent (wakes with zero debounce). */
export function addressedToAgent(
  doc: Partial<BenchDoc> & { externalId: string; title: string },
): BenchDoc {
  return {
    documentType: "document",
    content: doc.content ?? `Addressed note for ${doc.title}.`,
    ...doc,
    metadata: { ...(doc.metadata ?? {}), addressedToAgent: true },
  };
}

/**
 * Bulk marketing mail — the waker must never wake on it.
 *
 * The classifier reads the NORMALIZED `metadata.bulkMail` marker, not the raw
 * headers: header interpretation belongs to the provider, and the harness
 * pushes metadata verbatim. Setting only `listUnsubscribe`/`precedence` here
 * would produce a document that looks like bulk mail and still wakes.
 */
export function bulkMail(doc: Partial<BenchDoc> & { externalId: string; title: string }): BenchDoc {
  return {
    documentType: "email",
    content:
      doc.content ??
      "This month's offers from our newsletter. Unsubscribe at any time using the link below.",
    ...doc,
    metadata: {
      ...(doc.metadata ?? {}),
      bulkMail: true,
      from: "newsletter@example.com",
      listUnsubscribe: "<mailto:unsubscribe@example.com>",
      precedence: "bulk",
    },
  };
}

// ── plan fragments ──────────────────────────────────────────────────────────

/**
 * File a dated entry in the time index. Every parameter the tool accepts is
 * exposed: the reconcile-refusal (`force`) and backlink (`loopIds`,
 * `personIds`, `projectionIds`) paths are as testable as the happy one.
 */
export function fileTemporal(opts: {
  when: string;
  sentence: string;
  kind?: string;
  until?: string;
  documentIds?: unknown[];
  loopIds?: unknown[];
  personIds?: unknown[];
  projectionIds?: string[];
  evidence?: { docId: unknown; quote: string };
  force?: boolean;
}) {
  return call("temporal_annotation_add", {
    when: opts.when,
    sentence: opts.sentence,
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.until ? { until: opts.until } : {}),
    ...(opts.documentIds ? { documentIds: opts.documentIds } : {}),
    ...(opts.loopIds ? { loopIds: opts.loopIds } : {}),
    ...(opts.personIds ? { personIds: opts.personIds } : {}),
    ...(opts.projectionIds ? { projectionIds: opts.projectionIds } : {}),
    ...(opts.evidence ? { evidence: opts.evidence } : {}),
    ...(opts.force ? { force: true } : {}),
  });
}
