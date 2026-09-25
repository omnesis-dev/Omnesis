// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A source filter, against the source ids a real install actually has.
 *
 * A source is identified as `<type>` or `<type>:<account>`, and every account
 * of a type shares one declared profile — so the ontology a watch is validated
 * against names the **type**, while the documents a watch is evaluated against
 * carry the **account-qualified id**. A filter naming `gmail` is therefore
 * checked against a declaration that says `gmail` and matched against events
 * that say `gmail:someone@example.com`.
 *
 * Matching those by equality is the failure this file exists to prevent, and it
 * is invisible to a fixture: every synthetic universe names its sources by bare
 * type, so an equality check passes every test in the suite and then matches
 * nothing on an install that has ever added an account. The watch validates,
 * installs, sits active, and never fires — with no error anywhere, because
 * "no document matched the filter" is not an error.
 */

import { describe, expect, it } from "vitest";

import { Ontology } from "../ontology/snapshot.js";
import { WatchEngine } from "./engine.js";
import { WatchStateStore } from "./state.js";
import type { JournalEvent } from "../journal/event.js";

const ontology = Ontology.parse({
  fingerprint: "multi-account",
  sources: [
    {
      // Declared by type, which is how a profile is published.
      sourceId: "gmail",
      providerId: "google",
      semanticallyIndexed: true,
      profile: {
        documentTypes: ["email"],
        personRoles: ["sender"],
        metadataFields: [],
      },
    },
  ],
  analyticsTables: [],
  people: [],
});

/** A watch that fires on any gmail message, naming the source by type. */
function watchOn(source: string): Record<string, unknown> {
  return {
    name: "every-email",
    firing_policy: "stays_active",
    ontology_fingerprint: "multi-account",
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source, event: ["created"], documentType: "email" },
        output_map: { doc_id: "$e.docId" },
      },
    ],
    sink: { input: "mail", output_map: { doc_id: "$n.mail.doc_id" } },
  };
}

/** A document event carrying an account-qualified source id, as a real one does. */
function mail(seq: number, sourceId: string, docId: string): JournalEvent {
  const at = "2026-03-01T09:00:00Z";
  return {
    seq,
    kind: "doc.event",
    occurredAt: at,
    observedAt: at,
    payload: {
      op: "created",
      docId,
      sourceId,
      providerId: "google",
      documentType: "email",
      title: "a message",
      semanticTime: at,
      changedFields: [],
      contentChanged: false,
      metadata: {},
      people: [],
    },
  } as JournalEvent;
}

async function firingsFor(source: string, events: JournalEvent[]): Promise<number> {
  const store = new WatchStateStore();
  try {
    const trace = await new WatchEngine({
      watch: watchOn(source) as never,
      ontology,
      journal: events,
      analytics: { query: () => Promise.resolve({ rows: [], columns: [] }) },
      judge: { judge: () => ({ fired: false, output: {} }) },
      recall: { score: () => 0 },
      store,
    }).run();
    return trace.firings.length;
  } finally {
    store.close();
  }
}

const DOC_A = "aaaaaaaa-0000-4000-8000-000000000001";
const DOC_B = "bbbbbbbb-0000-4000-8000-000000000002";

describe("a filter naming a source type", () => {
  it("matches an account of that type", async () => {
    // The case that made every watch on a real install silent: the ontology
    // declares `gmail`, so the watch is written and validated against `gmail`,
    // and every document the install produces says `gmail:<account>`.
    const fired = await firingsFor("gmail", [mail(1, "gmail:someone@example.com", DOC_A)]);
    expect(fired, "a watch on `gmail` did not match a document from a gmail account").toBe(1);
  });

  it("matches every account of that type", async () => {
    const fired = await firingsFor("gmail", [
      mail(1, "gmail:one@example.com", DOC_A),
      mail(2, "gmail:two@example.org", DOC_B),
    ]);
    expect(fired, "a type-wide filter missed one of its accounts").toBe(2);
  });

  it("still matches a source that has no account suffix", async () => {
    // A single-account source, and every fixture universe. This is the case
    // that already worked and must keep working.
    expect(await firingsFor("gmail", [mail(1, "gmail", DOC_A)])).toBe(1);
  });

  it("does not match a different type that merely starts the same way", async () => {
    // `gmail` must not match `gmail-archive:…`. Prefix matching on the raw
    // string would; matching on the type component does not.
    expect(await firingsFor("gmail", [mail(1, "gmail-archive:x@example.com", DOC_A)])).toBe(0);
  });
});

describe("a filter naming one account", () => {
  it("matches only that account", async () => {
    // The narrower form has to keep meaning what it says, or an operator who
    // deliberately scoped a watch to one mailbox would silently get all of
    // them.
    const fired = await firingsFor("gmail:one@example.com", [
      mail(1, "gmail:one@example.com", DOC_A),
      mail(2, "gmail:two@example.org", DOC_B),
    ]);
    expect(fired, "an account-scoped filter matched another account").toBe(1);
  });
});
