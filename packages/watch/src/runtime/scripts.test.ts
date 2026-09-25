// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A scripted fixture names a document by id, and an id is opaque. Insert a
 * document into the middle of the generated journal and every later id shifts
 * by one, so a fixture that meant "the contract-signature email" quietly comes
 * to mean whatever now occupies that slot — the judge still answers, the watch
 * still fires, and the golden re-records around the change.
 *
 * Each entry therefore carries the title of the document it means, and this
 * test is the thing that reads it. The id stays authoritative; the title makes
 * a re-binding loud.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readJournal } from "../journal/read.js";
import { journalPath, universeDir } from "../universe/paths.js";
import { loadWatch } from "./run.js";

interface ScriptEntry {
  readonly documentId?: string;
  readonly title?: string;
}

describe("scripted fixtures", () => {
  const titles = new Map<string, string | undefined>();
  for (const event of readJournal(journalPath())) {
    if (event.kind === "doc.event") {
      const payload = event.payload as { docId: string; title?: string };
      if (!titles.has(payload.docId)) titles.set(payload.docId, payload.title);
    }
  }

  const dir = path.join(universeDir(), "scripts");
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));

  it("has a script for every watch that reaches a model", () => {
    // A watch with a semantic-match source or an llm node cannot replay
    // deterministically without scripted answers. Deriving the list from the
    // definitions means a new judging watch arrives with its script or reddens
    // the build, rather than silently replaying against an empty script.
    const watches = readdirSync(path.join(universeDir(), "watches"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""));

    const needsScript = watches.filter((name) => {
      const watch = loadWatch(name);
      // `judge`, not the old shape: a nominating source declares its judge as a
      // sibling now, and asking the old question silently dropped eight watches
      // out of this guarantee while the test stayed green on the three that
      // still use a bare `llm` node.
      return watch.nodes.some((node) => node.type === "llm" || "judge" in node);
    });

    expect(needsScript.length, "no watch in the corpus reaches a model").toBeGreaterThan(0);
    const have = new Set(files.map((f) => f.replace(/\.json$/, "")));
    expect(needsScript.filter((name) => !have.has(name))).toEqual([]);
  });

  it.each(files)("%s names the documents it means", (file) => {
    const raw = readFileSync(path.join(dir, file), "utf8");
    const script = JSON.parse(raw) as Record<string, ScriptEntry[]>;

    for (const section of ["recall", "judgements"]) {
      for (const entry of script[section] ?? []) {
        if (entry.documentId === undefined) continue;
        expect(titles.has(entry.documentId), `${entry.documentId} is not in the journal`).toBe(
          true,
        );
        expect(entry.title, `${file} → ${entry.documentId} has no title`).toBeDefined();
        expect(titles.get(entry.documentId)).toBe(entry.title);
      }
    }

    // Every document id anywhere in the file, not only the ones a `documentId`
    // field names. A judged output carries them too — `supporting_doc_ids` on a
    // verdict — and those reach the sink's payload, where the evaluation
    // compares them. An id that has drifted onto some other document is then a
    // reference reporting evidence it never saw, which is exactly the class of
    // answer-key defect the scored comparison exists to avoid.
    for (const id of raw.match(/d0c\d{5}-[0-9a-f-]{27}/g) ?? []) {
      expect(titles.has(id), `${file} names ${id}, which is not a document in the journal`).toBe(
        true,
      );
    }
  });

  it("pins the probe's documents on more than their id", () => {
    // The guard that let corpus growth reassign two scripted judgements onto
    // phone-call documents checked one field. An id is opaque and a title alone
    // is not unique — the season has seventeen documents called "Call" — so a
    // scripted reference names the title, the source and the sequence, and all
    // three have to agree with the journal. Any one of them drifting is loud.
    const probe = JSON.parse(readFileSync(path.join(universeDir(), "probe.json"), "utf8")) as {
      judgedOutputs?: Record<string, { title?: string; source?: string; seq?: number }>;
    };

    const journal = readJournal(journalPath());
    const facts = new Map<string, { title?: string; source: string; seq: number }>();
    for (const event of journal) {
      if (event.kind !== "doc.event") continue;
      const payload = event.payload as { docId: string; title?: string; sourceId: string };
      if (!facts.has(payload.docId)) {
        facts.set(payload.docId, {
          title: payload.title,
          source: payload.sourceId,
          seq: event.seq,
        });
      }
    }

    const entries = Object.entries(probe.judgedOutputs ?? {});
    expect(entries.length, "the probe names no document, so this asserts nothing").toBeGreaterThan(
      0,
    );
    for (const [documentId, entry] of entries) {
      const fact = facts.get(documentId);
      expect(
        fact,
        `probe.json names ${documentId}, which is not a document in the journal`,
      ).toBeDefined();
      expect(entry.title, `${documentId} has no title to check`).toBe(fact!.title);
      expect(entry.source, `${documentId} has no source to check`).toBe(fact!.source);
      expect(entry.seq, `${documentId} has no sequence to check`).toBe(fact!.seq);
    }
  });

  it("names only watches that exist, and names one for every verdict", () => {
    // Both new fields are free text. A typo in `selective` returns that
    // reference to firing on the season's whole traffic, and a typo in an
    // entry's `watch` makes its verdict corpus-wide — and the package stayed
    // green through either.
    const probe = JSON.parse(readFileSync(path.join(universeDir(), "probe.json"), "utf8")) as {
      judgedOutputs?: Record<string, { watch?: string }>;
      selective?: string[];
    };
    const watches = new Set(
      readdirSync(path.join(universeDir(), "watches"))
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.replace(/\.json$/, "")),
    );

    expect(
      probe.selective?.length,
      "nothing is selective, so this asserts nothing",
    ).toBeGreaterThan(0);
    for (const name of probe.selective ?? []) {
      expect(watches.has(name), `selective names '${name}', which is not a watch`).toBe(true);
    }
    for (const [documentId, entry] of Object.entries(probe.judgedOutputs ?? {})) {
      expect(
        entry.watch,
        `${documentId} names no watch, so its verdict answers for all of them`,
      ).toBeDefined();
      expect(
        watches.has(entry.watch!),
        `${documentId} is scoped to '${entry.watch}', which is not a watch`,
      ).toBe(true);
    }
  });

  it("names documents from the anchored block, whose ids do not move", () => {
    // Generation-order ids shift when a document is inserted earlier in the
    // season; anchored ones do not. A script naming an unanchored id keeps
    // working while quietly coming to mean a different document.
    const wandering: string[] = [];
    for (const file of files) {
      const raw = readFileSync(path.join(dir, file), "utf8");
      for (const id of raw.match(/d0c\d{5}-[0-9a-f-]{27}/g) ?? []) {
        if (!id.startsWith("d0c00001-")) wandering.push(`${file} → ${id}`);
      }
    }
    expect(wandering).toEqual([]);
  });
});
