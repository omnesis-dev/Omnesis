// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The upgrade to multilingual keyword search (lexical version 1), end to end.
 *
 * A real gateway indexes mixed-language documents with lexical version 0,
 * which cuts words at spaces only: a Chinese sentence is one token, Korean
 * words carry their particles, Russian words only match their exact form. It
 * then restarts on the code's own target, version 1, which rebuilds the
 * keyword index in the background. English search must answer the same way
 * throughout, the other languages must stay as they were until the switch, and
 * after it they must be found by the words a person would search for.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

// Titles never contain a searched word, so only the analyzed text can match.
const DOCUMENTS = [
  {
    externalId: "en-budget",
    title: "English note",
    content: "The quarterly quokka budget review covers travel",
  },
  { externalId: "zh-library", title: "Chinese note", content: "我昨天在图书馆借了三本书" },
  { externalId: "ko-school", title: "Korean note", content: "어제 학교에서 친구를 만났습니다" },
  {
    externalId: "ru-books",
    title: "Russian note",
    content: "Я читаю интересные книги каждый вечер",
  },
];
/** English filler, so the rebuild runs long enough to search during it. */
const FILLER = Array.from({ length: 400 }, (_, i) => ({
  externalId: `filler-${i}`,
  title: `Meeting notes ${i}`,
  content: `Meeting notes ${i} about the harbor renovation schedule`,
}));

interface SearchAnswer {
  results: Array<{ documentId: string; title: string }>;
  stages?: { bm25?: { lexicalVersion?: number } };
}

interface LexicalStatus {
  activeVersion: number | null;
  targetVersion: number;
  retiring: boolean;
  building: { version: number; phase: string } | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Upgrading keyword search to multilingual analysis", () => {
  let harness: SyntheticE2EHarness;

  const search = (text: string) =>
    harness.gatewayJson<SearchAnswer>("/search", {
      method: "POST",
      body: JSON.stringify({ text, limit: 10 }),
    });
  const titles = async (text: string) => (await search(text)).results.map((r) => r.title);
  const lexical = async (): Promise<LexicalStatus | undefined> =>
    (await harness.gatewayJson<{ lexicalIndex?: LexicalStatus }>("/index/stats")).lexicalIndex;
  const until = async (what: string, done: (s: LexicalStatus) => boolean, timeoutMs = 300_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await lexical().catch(() => undefined);
      if (status && done(status)) return status;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}: ${JSON.stringify(status)}`);
      await sleep(250);
    }
  };

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      universe: "e2e-minimal",
      extraGatewayConfig: { indexer: { lexicalRebuild: { batchSize: 10, pause: "300ms" } } },
      // Start as a release from before version 1 would.
      extraGatewayEnv: { OMNESIS_LEXICAL_TEST_VERSION: "0" },
    });
    await harness.start();
    await harness.pushDocuments([...DOCUMENTS, ...FILLER]);
    await until("version 0 to be active", (s) => s.activeVersion === 0);
    const deadline = Date.now() + 120_000;
    while ((await titles("quokka")).length === 0 && Date.now() < deadline) await sleep(250);
  }, 300_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  test("version 0 finds English but not words inside Chinese, Korean or Russian text", async () => {
    expect(await titles("quokka")).toEqual(["English note"]);
    expect(await titles("图书馆")).toEqual([]);
    expect(await titles("학교")).toEqual([]);
    expect(await titles("книга")).toEqual([]);
  });

  test("the upgrade rebuilds in the background, and the other languages are found after the switch", async () => {
    await harness.restartGateway({ extraGatewayEnv: {} });
    const building = await until("the rebuild to version 1", (s) => s.building?.version === 1);
    expect(building).toMatchObject({ activeVersion: 0, targetVersion: 1 });

    // During the rebuild: version 0 answers, English as before.
    const during = await search("quokka");
    expect(during.stages?.bm25?.lexicalVersion).toBe(0);
    expect(during.results.map((r) => r.title)).toEqual(["English note"]);

    await until(
      "the switch to version 1",
      (s) => s.activeVersion === 1 && s.building === null && !s.retiring,
    );
    const after = await search("quokka");
    expect(after.stages?.bm25?.lexicalVersion).toBe(1);
    expect(after.results.map((r) => r.title)).toEqual(["English note"]);
    expect(await titles("harbor renovation")).toHaveLength(10);

    // A word inside an unspaced Chinese sentence.
    expect(await titles("图书馆")).toEqual(["Chinese note"]);
    // A Korean noun without the particle it is written with.
    expect(await titles("학교")).toEqual(["Korean note"]);
    // A Russian word in another grammatical form.
    expect(await titles("книга")).toEqual(["Russian note"]);
  }, 400_000);
});
