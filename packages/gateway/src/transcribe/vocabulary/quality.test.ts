// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
import { SourceId } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { adaptTranscriptionVocabulary } from "../vocabulary-adapter.js";
import { extractTranscriptionVocabulary } from "./extract.js";
import {
  advanceTranscriptionVocabularyRebuild,
  transcriptionVocabularyGeneration,
} from "./rebuild.js";
import {
  applyTranscriptionVocabularyBatch,
  fetchTranscriptionVocabularyBatch,
  getTranscriptionVocabulary,
} from "./storage.js";
import type { Db } from "../../data/types.js";
import type { VocabularySettings } from "./types.js";

const settings: VocabularySettings = {
  enabled: true,
  maxTerms: 64,
  maxPromptTokens: 96,
  batchSize: 4,
  maxDocumentChars: 32768,
  maxTermsPerDocument: 64,
  periodMs: 1000,
  idlePeriodMs: 60000,
};
const date = "2026-02-01T10:00:00.000Z";
const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

// These domains, identities, brands and messages are invented solely for this test.
const domains = [
  {
    sourceId: "fictional:calibration",
    locale: "en-US",
    name: "Ovelia Ternol",
    product: "lumaVey",
    acronym: "KZQ",
    messages: [
      "please tune lumaVey using KZQ before the next measurement",
      "the lumaVey measurement uses KZQ again after the adjustment",
    ],
    common: ["please", "before", "the", "next", "again"],
  },
  {
    sourceId: "fictional:ink-formulation",
    locale: "fr-FR",
    name: "Mérunie Valsère",
    product: "giroNéa",
    acronym: "XVL",
    messages: [
      "merci de tester giroNéa avec XVL avant la prochaine mesure",
      "la mesure de giroNéa utilise encore XVL après le changement",
    ],
    common: ["merci", "avec", "avant", "la", "après"],
  },
] as const;
type Domain = (typeof domains)[number];

function materialize(
  domain: Domain,
  options: { rendered?: boolean; sent?: boolean; boilerplate?: boolean; count?: number } = {},
) {
  const db = createDatabase(":memory:");
  databases.push(db);
  // Exercise the real readiness seam, including any initialization migration;
  // never write a guessed generation or bypass the materialization fence.
  expect(advanceTranscriptionVocabularyRebuild(db, settings).ready).toBe(true);
  const generation = transcriptionVocabularyGeneration(db);
  expect(generation).toBe(1);
  const person = db.prepare(
    `INSERT INTO people(id,canonical_name,source,is_self,first_seen,last_seen,created_at,updated_at)
     VALUES (?,?,'fictional',?,?,?,?,?)`,
  );
  person.run("self", "Ivero Calden", 1, date, date, date, date);
  person.run("peer", domain.name, 0, date, date, date, date);
  const insert = db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,
      source_created_at,source_updated_at,ingested_at,updated_at,people_resolved_at)
     VALUES (?,'fictional',?,?,'',?,?,?,?,?,?,?,?)`,
  );
  const link = db.prepare(
    "INSERT INTO document_people(document_id,person_id,role,source_id) VALUES (?,?,?,?)",
  );
  for (let index = 0; index < (options.count ?? domain.messages.length); index++) {
    const id = `document-${index}`;
    let body: string = domain.messages[index];
    if (options.boilerplate)
      body +=
        "\n" +
        "ALVEK BORVAN CELRIN DERVAL\nELNAR FOVREL GARVAN HUNREL\nIVRAN JOVREL KELVAN LUNREL\nZALVORINQUENREL\n".repeat(
          4,
        );
    if (options.rendered) {
      body = `# Dispatch Template\n**Author:** RenderedCaster\n**Recipient:** ArchiveMarker\n---\n**09:12** TemplateByline: [Voice note, 0:10]: ${body}\n  → DiscardedReply Marker\n> QuotedMarker SyntheticArchive\n\`\`\`text\nFencedMarker TEMPLATE\n\`\`\`\n---\n**Attachments:** TemplateBundle.bin (application/octet-stream, 2KB)`;
    }
    insert.run(
      id,
      domain.sourceId,
      id,
      body,
      `hash-${index}`,
      JSON.stringify({ extra: { conversationId: "experiment-thread" } }),
      date,
      date,
      date,
      date,
      date,
    );
    link.run(id, "self", options.sent ? "sender" : "recipient", domain.sourceId);
    link.run(id, "peer", options.sent ? "recipient" : "sender", domain.sourceId);
  }
  const batch = fetchTranscriptionVocabularyBatch(db, settings);
  expect(batch).toHaveLength(options.count ?? 2);
  expect(batch.every((doc) => doc.generation === generation)).toBe(true);
  const applied = applyTranscriptionVocabularyBatch(
    db,
    extractTranscriptionVocabulary(batch, settings),
  );
  expect(applied.skipped).toBe(0);
  expect(applied.remaining).toEqual([]);
  const dictionary = getTranscriptionVocabulary(
    db,
    {
      purpose: "source-audio",
      speaker: { personId: "peer" },
      participants: [{ isSelf: true }, { personId: "peer" }],
      conversation: { sourceId: SourceId(domain.sourceId), threadId: "experiment-thread" },
      languageHints: [domain.locale],
      recordedAt: date,
    },
    settings,
  );
  const prompt = adaptTranscriptionVocabulary(dictionary, {
    runtime: "smart-whisper",
    maxPromptTokens: settings.maxPromptTokens,
  })?.initial_prompt;
  expect(prompt).toBeDefined();
  expect(Buffer.byteLength(prompt!, "utf8")).toBeLessThanOrEqual(96);
  return { dictionary, prompt: prompt! };
}

function useful(result: ReturnType<typeof materialize>, domain: Domain) {
  expect(result.prompt).toContain(domain.name);
  expect(result.prompt).toContain(domain.product);
  expect(result.prompt).toContain(domain.acronym);
  const terms = result.dictionary.entries.map((entry) => entry.text.toLocaleLowerCase("und"));
  for (const common of domain.common) expect(terms).not.toContain(common);
}

describe("transcription vocabulary quality on independent fictional domains", () => {
  for (const domain of domains) {
    test(`${domain.locale}: sent and received prose retain the same useful vocabulary`, () => {
      const received = materialize(domain);
      const sent = materialize(domain, { sent: true });
      useful(received, domain);
      useful(sent, domain);
      expect(sent.prompt).toBe(received.prompt);
    });

    test(`${domain.locale}: rendered metadata does not consume useful prompt space`, () => {
      const clean = materialize(domain);
      const rendered = materialize(domain, { rendered: true });
      useful(rendered, domain);
      expect(rendered.prompt).toBe(clean.prompt);
      for (const noise of [
        "Template",
        "Archive",
        "RenderedCaster",
        "Byline",
        "QuotedMarker",
        "FencedMarker",
      ])
        expect(rendered.prompt).not.toContain(noise);
    });

    test(`${domain.locale}: products and grounded full names survive repeated uppercase prose`, () => {
      const noisy = materialize(domain, { boilerplate: true });
      expect(noisy.prompt).toContain(domain.name);
      expect(noisy.prompt).toContain(domain.product);
      // Equally repeated uppercase prose is ambiguous. The acronym remains
      // eligible, but a small prompt cannot promise space for every weak term.
      expect(noisy.dictionary.entries.map((entry) => entry.text)).toContain(domain.acronym);
    });

    test(`${domain.locale}: long uppercase boilerplate also needs independent evidence`, () => {
      const once = materialize(domain, { count: 1, boilerplate: true });
      expect(once.dictionary.entries.map((entry) => entry.text)).not.toContain("ZALVORINQUENREL");
    });

    test(`${domain.locale}: a novel acronym needs independent prose evidence`, () => {
      const once = materialize(domain, { count: 1 });
      expect(once.dictionary.entries.map((entry) => entry.text)).not.toContain(domain.acronym);
      useful(materialize(domain), domain);
    });
  }
});
