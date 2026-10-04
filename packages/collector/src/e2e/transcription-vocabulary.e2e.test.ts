// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Real scheduled vocabulary materialization and authenticated dictionary reads.
 * Audio inference is deliberately replay-only here; gateway Whisper seam tests
 * separately prove packing and native-worker delivery without model inference.
 */
import "./synth-env.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { SourceId } from "@omnesis/types";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { TranscriptionContext, TranscriptionVocabulary } from "@omnesis/core";

const SOURCE_A = "synthetic:voice-context@example.org";
const SOURCE_B = "synthetic:mail-context@example.org";
const THREAD = "fictional-conversation";
const EMAIL = "speaker@example.org";
const PHONE = "+15550100142";
const ENDPOINT = "/inference/transcription-vocabulary";

async function dictionary(
  harness: SyntheticE2EHarness,
  context: TranscriptionContext,
): Promise<TranscriptionVocabulary> {
  return harness.gatewayJson(ENDPOINT, { method: "POST", body: JSON.stringify(context) });
}

async function tick(harness: SyntheticE2EHarness): Promise<void> {
  await harness.gatewayJson(
    "/admin/background/run/transcription.vocabularyBackfill?timeoutMs=30000",
    { method: "POST" },
  );
}

function score(vocabulary: TranscriptionVocabulary, text: string): number {
  return (
    vocabulary.entries.find((entry) => entry.text.toLowerCase() === text.toLowerCase())?.score ?? 0
  );
}

describe("transcription vocabulary materialization and API (E2E)", () => {
  let harness: SyntheticE2EHarness;
  let db: Database.Database;
  let omittedSettingBoot: {
    dictionary: TranscriptionVocabulary;
    processedDocuments: number;
    vocabularyRows: number;
    jobState: string;
    advertised: boolean;
  };

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      universe: "e2e-minimal",
      extraGatewayConfig: {
        inference: { transcriptionVocabulary: { maxTerms: 8, periodMs: 100, idlePeriodMs: 1000 } },
      },
      initialDocuments: [
        {
          sourceId: SOURCE_A,
          externalId: "vocab-voice-thread",
          title: "Vocabulary context",
          content:
            "Quenlora quenlora is the project. A stray zeriVex appears here only. The and this are ordinary words.",
          metadata: {
            documentType: "conversation",
            extra: { conversationId: THREAD },
            people: [
              {
                role: "participant",
                identifiers: [
                  { kind: "phone", value: PHONE },
                  { kind: "email", value: EMAIL },
                ],
              },
              { role: "participant", isSelf: true },
            ],
          },
        },
        {
          sourceId: SOURCE_A,
          externalId: "vocab-voice-followup",
          title: "Project follow-up",
          content: "We reviewed the Quenlora project and agreed on the next step.",
          metadata: {
            documentType: "conversation",
            extra: { conversationId: THREAD },
            people: [
              { role: "participant", identifiers: [{ kind: "phone", value: PHONE }] },
              { role: "participant", isSelf: true },
            ],
          },
        },
        {
          sourceId: SOURCE_B,
          externalId: "vocab-mail-context",
          title: "Vocabulary context",
          content: "Vexluma vexluma is the specialist term in this exchange.",
          metadata: {
            documentType: "email",
            people: [{ role: "sender", identifiers: [{ kind: "email", value: EMAIL }] }],
          },
        },
        {
          sourceId: SOURCE_B,
          externalId: "vocab-mail-followup",
          title: "Exchange follow-up",
          content: "We continued the Vexluma discussion with a revised proposal.",
          metadata: {
            documentType: "email",
            people: [{ role: "sender", identifiers: [{ kind: "email", value: EMAIL }] }],
          },
        },
        {
          sourceId: SOURCE_B,
          externalId: "vocab-unrelated-context",
          title: "Vocabulary context",
          content: "Zelvanta zelvanta is the unrelated project.",
          metadata: {
            documentType: "email",
            people: [
              {
                role: "sender",
                identifiers: [{ kind: "email", value: "other-speaker@example.org" }],
              },
            ],
          },
        },
        {
          sourceId: SOURCE_B,
          externalId: "vocab-unrelated-followup",
          title: "Separate project update",
          content: "We saw the Zelvanta team complete a milestone this week.",
          metadata: {
            documentType: "email",
            people: [
              {
                role: "sender",
                identifiers: [{ kind: "email", value: "other-speaker@example.org" }],
              },
            ],
          },
        },
      ],
    });
    await harness.start();
    db = new Database(harness.getDbPath(), { readonly: true });
    await tick(harness);
    const readCount = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
    omittedSettingBoot = {
      dictionary: await dictionary(harness, { purpose: "dictation" }),
      processedDocuments: readCount(
        "SELECT count(*) AS count FROM documents WHERE vocabulary_processed_at IS NOT NULL",
      ),
      vocabularyRows: readCount("SELECT count(*) AS count FROM transcription_vocabulary_terms"),
      jobState: "",
      advertised: (await harness.gatewayJson<{ transcriptionVocabulary: boolean }>("/status"))
        .transcriptionVocabulary,
    };
    await vi.waitFor(
      async () => {
        const snapshot = await harness.gatewayJson<{
          jobs: Array<{ id: string; observation: { state: string } }>;
        }>("/admin/background-jobs");
        omittedSettingBoot.jobState =
          snapshot.jobs.find((job) => job.id === "transcription.vocabularyBackfill")?.observation
            .state ?? "";
        expect(omittedSettingBoot.jobState).toBe("disabled");
      },
      { timeout: 15_000, interval: 250 },
    );
    await harness.gatewayJson("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ inference: { transcriptionVocabulary: { enabled: true } } }),
    });
    await vi.waitFor(
      async () => {
        await tick(harness);
        expect(
          db
            .prepare(
              "SELECT count(*) AS count FROM documents WHERE external_id LIKE 'vocab-%' AND vocabulary_processed_at IS NOT NULL",
            )
            .get(),
        ).toEqual({ count: 6 });
      },
      { timeout: 90_000, interval: 500 },
    );
  }, 150_000);

  afterAll(async () => {
    db?.close();
    await harness?.destroy();
  }, 15_000);

  test("omitted opt-in starts with no materialization, hints, or active background job", () => {
    expect(omittedSettingBoot).toEqual({
      dictionary: {
        enabled: false,
        entries: [],
        refreshAfterSeconds: 1800,
        expiresAfterSeconds: 86400,
      },
      processedDocuments: 0,
      vocabularyRows: 0,
      jobState: "disabled",
      advertised: false,
    });
  });

  test("advertises client hints independently from gateway dictation and serves a private snapshot", async () => {
    await harness.gatewayJson("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ inference: { dictation: { transcribeOnGateway: false } } }),
    });
    const status = await harness.gatewayJson<{
      transcriptionVocabulary: boolean;
      dictation: { active: boolean };
    }>("/status");
    expect(status.transcriptionVocabulary).toBe(true);
    expect(status.dictation.active).toBe(false);
    const response = await harness.gatewayFetch(ENDPOINT, {
      method: "POST",
      body: JSON.stringify({ purpose: "agent", speaker: { isSelf: true } }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const snapshot = await response.json();
    expect(snapshot).toMatchObject({
      enabled: true,
      refreshAfterSeconds: 1800,
      expiresAfterSeconds: 86400,
    });
    expect(snapshot.entries.length).toBeGreaterThan(0);
  });

  test("selects relationship vocabulary across sources using canonical aliases", async () => {
    const general = await dictionary(harness, { purpose: "dictation", speaker: { isSelf: true } });
    const contextual = await dictionary(harness, {
      purpose: "source-audio",
      speaker: { identifiers: [{ kind: "phone", value: PHONE }] },
      conversation: { sourceId: SourceId(SOURCE_A), threadId: THREAD },
    });
    expect(score(general, "Vexluma")).toBeGreaterThan(0);
    expect(score(contextual, "Vexluma")).toBeGreaterThan(score(general, "Vexluma"));
    expect(score(contextual, "Quenlora")).toBeGreaterThan(score(contextual, "Vexluma"));
    expect(score(contextual, "Vexluma")).toBeGreaterThan(score(contextual, "Zelvanta"));
    expect(contextual.entries.length).toBeLessThanOrEqual(8);
    expect(
      contextual.entries.every((entry) => Number.isFinite(entry.score) && entry.score > 0),
    ).toBe(true);
    expect(
      contextual.entries.some((entry) => ["the", "and", "this"].includes(entry.text.toLowerCase())),
    ).toBe(false);
  });

  test("a mixed-case singleton remains ineligible after scheduled extraction", async () => {
    expect(
      db
        .prepare(
          "SELECT document_count FROM transcription_vocabulary_terms WHERE scope_kind='global' AND term='zerivex'",
        )
        .get(),
    ).toEqual({ document_count: 1 });
    expect(score(await dictionary(harness, { purpose: "dictation" }), "zeriVex")).toBe(0);
  });

  test("requires corpus read access and bounds context before selection", async () => {
    const created = await harness.gatewayJson<{ device: { id: string }; token: string }>(
      "/admin/devices",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Vocabulary writer fixture",
          kind: "cli",
          scopes: ["write:*"],
        }),
      },
    );
    const response = await fetch(`${harness.gatewayUrl}${ENDPOINT}`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.token}`, "content-type": "application/json" },
      body: JSON.stringify({ purpose: "dictation" }),
    });
    expect(response.status).toBe(403);
    const invalid = await harness.gatewayFetch(ENDPOINT, {
      method: "POST",
      body: JSON.stringify({
        purpose: "source-audio",
        participants: Array.from({ length: 33 }, () => ({ isSelf: true })),
      }),
    });
    expect(invalid.status).toBe(400);
  });

  test("live disable stops vocabulary reads and background materialization, then re-enable catches up", async () => {
    await harness.gatewayJson("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ inference: { transcriptionVocabulary: { enabled: false } } }),
    });
    await harness.pushDocuments([
      {
        sourceId: SOURCE_A,
        externalId: "vocab-disabled-document",
        title: "Vocabulary context",
        content: "Nuvriala nuvriala is newly introduced.",
      },
    ]);
    await tick(harness);
    expect(await dictionary(harness, { purpose: "dictation" })).toMatchObject({
      enabled: false,
      entries: [],
    });
    expect(
      (await harness.gatewayJson<{ transcriptionVocabulary: boolean }>("/status"))
        .transcriptionVocabulary,
    ).toBe(false);
    expect(
      db
        .prepare(
          "SELECT vocabulary_processed_at AS processed FROM documents WHERE external_id = 'vocab-disabled-document'",
        )
        .get(),
    ).toEqual({ processed: null });
    expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM transcription_vocabulary_terms WHERE term = 'nuvriala'",
        )
        .get(),
    ).toEqual({ count: 0 });
    await harness.gatewayJson("/admin/config", {
      method: "PATCH",
      body: JSON.stringify({ inference: { transcriptionVocabulary: { enabled: true } } }),
    });
    await vi.waitFor(
      async () => {
        await tick(harness);
        expect(
          db
            .prepare(
              "SELECT document_count FROM transcription_vocabulary_terms WHERE scope_kind='global' AND term='nuvriala'",
            )
            .get(),
        ).toEqual({ document_count: 1 });
      },
      { timeout: 30_000, interval: 500 },
    );
    expect(score(await dictionary(harness, { purpose: "dictation" }), "Nuvriala")).toBe(0);
    await harness.pushDocuments([
      {
        sourceId: SOURCE_A,
        externalId: "vocab-enabled-corroboration",
        title: "Follow-up discussion",
        content: "We discussed Nuvriala again and recorded the outcome.",
      },
    ]);
    await vi.waitFor(
      async () => {
        await tick(harness);
        expect(
          score(await dictionary(harness, { purpose: "dictation" }), "Nuvriala"),
        ).toBeGreaterThan(0);
      },
      { timeout: 30_000, interval: 500 },
    );
  });
});
