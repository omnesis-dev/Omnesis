// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which output fields carry a document, decided from the definition.
 *
 * The property that matters is the negative one: a field this cannot *prove*
 * carries a document must not be marked. A debug surface renders a marked value
 * as a document chip, so a wrong mark shows the operator a chip for a document
 * that does not exist, with nothing on the page saying it guessed.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { watchDslSchema } from "./schema.js";
import { documentLineage, SINK_LINEAGE_KEY } from "./lineage.js";

function lineageOf(nodes: unknown[], sinkOutput: Record<string, string>, sinkInput: string) {
  const parsed = watchDslSchema.parse({
    watch: {
      name: "a-watch",
      firing_policy: "stays_active",
      ontology_fingerprint: "an-install-fingerprint",
      nodes,
      sink: { input: sinkInput, output_map: sinkOutput },
    },
  });
  return documentLineage(parsed.watch);
}

const source = (id: string, output_map: Record<string, string>) => ({
  id,
  type: "source.document_event",
  filter: { source: "mailbox:someone@example.com", event: ["created"] },
  output_map,
});

describe("document lineage", () => {
  it("marks a field that is the arriving event's own document id", () => {
    const lineage = lineageOf([source("mail", { doc_id: "$e.docId" })], {}, "mail");

    expect([...(lineage.get("mail") ?? [])]).toEqual(["doc_id"]);
  });

  it("leaves every other field of the same node unmarked", () => {
    const lineage = lineageOf(
      [source("mail", { doc_id: "$e.docId", subject: "$e.title", when: "$e.semanticTime" })],
      {},
      "mail",
    );

    expect(lineage.get("mail")?.has("subject")).toBe(false);
    expect(lineage.get("mail")?.has("when")).toBe(false);
  });

  // The rename case. A field named nothing like a document still carries one,
  // and a field named exactly like one may not — which is why the name is never
  // consulted.
  it("follows the value rather than the name, in both directions", () => {
    const lineage = lineageOf(
      [source("mail", { whatever: "$e.docId", doc_id: "$e.title" })],
      {},
      "mail",
    );

    expect(lineage.get("mail")?.has("whatever")).toBe(true);
    expect(lineage.get("mail")?.has("doc_id")).toBe(false);
  });

  it("carries the mark downstream through a node reference", () => {
    const lineage = lineageOf(
      [
        source("mail", { doc_id: "$e.docId" }),
        {
          id: "hold",
          type: "stateful.wait",
          inputs: { mail: { role: "arm" } },
          on_collision: "ignore",
          duration: "1 hour",
          output_map: { evidence: "$n.mail.doc_id" },
        },
      ],
      { shown: "$n.hold.evidence" },
      "hold",
    );

    expect(lineage.get("hold")?.has("evidence")).toBe(true);
    expect(lineage.get(SINK_LINEAGE_KEY)?.has("shown")).toBe(true);
  });

  // The join case the operator asked about: a node fed by two arms shows the
  // document each arm brought, and both are documents.
  it("marks both arms of a join that carries each one's document", () => {
    const lineage = lineageOf(
      [
        source("by_mail", { doc_id: "$e.docId" }),
        source("by_chat", { doc_id: "$e.docId" }),
        {
          id: "both_channels",
          type: "stateful.and",
          inputs: { by_mail: { role: "arm" }, by_chat: { role: "arm" } },
          deadline: "2 days",
          on_collision: "ignore",
          output_map: { mailed: "$n.by_mail.doc_id", chatted: "$n.by_chat.doc_id" },
        },
      ],
      { mailed: "$n.both_channels.mailed", chatted: "$n.both_channels.chatted" },
      "both_channels",
    );

    expect([...(lineage.get("both_channels") ?? [])].sort()).toEqual(["chatted", "mailed"]);
    expect([...(lineage.get(SINK_LINEAGE_KEY) ?? [])].sort()).toEqual(["chatted", "mailed"]);
  });

  it("marks a call only when every branch of it is a document", () => {
    const lineage = lineageOf(
      [
        source("by_mail", { doc_id: "$e.docId", subject: "$e.title" }),
        source("by_chat", { doc_id: "$e.docId" }),
        {
          id: "either",
          type: "stateless.or",
          inputs: { by_mail: { role: "arm" }, by_chat: { role: "arm" } },
          output_map: {
            whichever: "coalesce($n.by_mail.doc_id, $n.by_chat.doc_id)",
            mixed: "coalesce($n.by_mail.doc_id, $n.by_mail.subject)",
          },
        },
      ],
      {},
      "either",
    );

    expect(lineage.get("either")?.has("whichever")).toBe(true);
    // Sometimes a document is not a document. A chip that is right half the
    // time is worse than the string it replaced.
    expect(lineage.get("either")?.has("mixed")).toBe(false);
  });

  it("says nothing about a watch whose fields carry no document", () => {
    const lineage = lineageOf([source("mail", { subject: "$e.title" })], {}, "mail");

    expect(lineage.size).toBe(0);
  });

  // A document id reached out of metadata is a string the DSL cannot prove is
  // a document — the ontology types that field, and it may hold anything.
  it("does not mark a document id the definition cannot prove is one", () => {
    const lineage = lineageOf(
      [source("mail", { doc_id: "$e.metadata.extra.threadId" })],
      {},
      "mail",
    );

    expect(lineage.size).toBe(0);
  });

  it("does not mark a call that computes something new from document arguments", () => {
    // `date_trunc` always produces a truncated instant — the validator types
    // its result TIMESTAMP whatever it was handed — so following it through
    // its arguments the way a pass-through function is followed marks a value
    // that is provably never a document.
    const lineage = lineageOf(
      [source("mail", { when: "date_trunc($e.docId, $e.docId)" })],
      {},
      "mail",
    );

    expect(lineage.get("mail")?.has("when") ?? false).toBe(false);
  });

  it("does not mark a call to a function the DSL does not implement", () => {
    // The validator rejects the watch, so nothing here has to be a second
    // opinion — but until it does, an unknown function has proven nothing and
    // a chip would be a guess.
    const lineage = lineageOf([source("mail", { passed_along: "identity($e.docId)" })], {}, "mail");

    expect(lineage.size).toBe(0);
  });

  it("marks the document a source projects when it renames nothing", () => {
    // A node with no output_map forwards the arriving event's own fields, so
    // `$n.mail.docId` is the document id as surely as `$e.docId` is — and
    // citing it that way from the sink is an ordinary way to write a watch.
    const lineage = lineageOf(
      [
        {
          id: "mail",
          type: "source.document_event",
          filter: { source: "mailbox:someone@example.com", event: ["created"] },
        },
      ],
      { which: "$n.mail.docId" },
      "mail",
    );

    expect(lineage.get("mail")?.has("docId")).toBe(true);
    expect(lineage.get(SINK_LINEAGE_KEY)?.has("which")).toBe(true);
  });

  it("marks nothing native on a source that carries no document", () => {
    // An analytics row's columns arrive under `$e.row.*` and none of them is a
    // document; projecting the event wholesale must not invent one.
    const lineage = lineageOf(
      [
        {
          id: "txn",
          type: "source.analytics_row",
          table: "plaid_transactions",
          op: ["inserted"],
        },
      ],
      {},
      "txn",
    );

    expect(lineage.size).toBe(0);
  });

  it("resolves a chain declared out of order", () => {
    // The DSL does not require an author to list nodes topologically, so a
    // single pass would leave the later-declared source unresolved and the
    // node reading it unmarked.
    const lineage = lineageOf(
      [
        {
          id: "hold",
          type: "stateful.wait",
          inputs: { mail: { role: "arm" } },
          on_collision: "ignore",
          duration: "1 hour",
          output_map: { evidence: "$n.mail.doc_id" },
        },
        source("mail", { doc_id: "$e.docId" }),
      ],
      {},
      "hold",
    );

    expect(lineage.get("hold")?.has("evidence")).toBe(true);
  });
});
