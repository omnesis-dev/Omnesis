// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { authorizeMcpClient, type AuthorizedMcpClient } from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import {
  startDecisionServer,
  type DecisionServer,
  type DecisionServerRequest,
} from "./brain-bench/decision-server.js";

/**
 * The mention layer of `temporal_query` end to end on a stable gateway: the
 * date recognizer's background drip scans the synthetic corpus, and a Direct
 * client reads the dates written in document text back through the generally
 * available tool.
 */
describe("temporal query mentions — synthetic-corpus gateway", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "default" });
    await harness.start();
    await harness.syncAllSources();
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("reads date mentions from document text through temporal_query without experimental mode", async () => {
    const authorized = await oauthClient({
      principalName: "Mention retrieval assistant",
      grantName: "Mention retrieval access",
      credentialLabel: "Fictional mention desktop",
      capabilities: ["direct"],
    });
    try {
      // The recognizer runs as a background drip on the stable gateway; wait
      // until it has scanned the whole synthetic corpus.
      const deadline = Date.now() + 90_000;
      for (;;) {
        const probe = await authorized.client.callTool({
          name: "temporal_query",
          arguments: { from: "2025-01-01", to: "2025-01-02", origins: ["mention"], limit: 1 },
        });
        expect(probe.isError).not.toBe(true);
        const pending = (
          probe.structuredContent as {
            data: { coverage: { mentions?: { pendingDocuments: number } } };
          }
        ).data.coverage.mentions?.pendingDocuments;
        expect(pending).toBeTypeOf("number");
        if (pending === 0) break;
        if (Date.now() > deadline)
          throw new Error(`Date extraction still has ${pending} documents pending`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const db = new Database(harness.getDbPath(), { readonly: true });
      let expected: { document_id: string; mention_start_day: string; matched_text: string };
      try {
        const row = db
          .prepare<[], { document_id: string; mention_start_day: string; matched_text: string }>(
            // A mention the layer shows: from the corpus, and the latest
            // message of its thread to name those days.
            `SELECT x.document_id, x.mention_start_day, x.matched_text
               FROM document_extracted_dates x JOIN documents d ON d.id = x.document_id
              WHERE x.mention_start_day IS NOT NULL
                AND d.source_id NOT IN ('omnesis-chat', 'open-loops')
                AND (x.thread_key IS NULL OR NOT EXISTS (
                  SELECT 1 FROM document_extracted_dates y JOIN documents dy ON dy.id = y.document_id
                   WHERE y.thread_key = x.thread_key
                     AND y.mention_start_day = x.mention_start_day
                     AND y.mention_end_day = x.mention_end_day
                     AND y.document_id <> x.document_id
                     AND (dy.source_created_at > d.source_created_at
                          OR (dy.source_created_at = d.source_created_at AND dy.id > d.id))))
              ORDER BY x.mention_start_day, x.id LIMIT 1`,
          )
          .get();
        if (!row) throw new Error("The synthetic corpus yielded no indexable date mention");
        // The earliest start day in the corpus: no mention can reach this
        // window by its end alone, so every item starts on it.
        expected = row;
      } finally {
        db.close();
      }

      type MentionItem = {
        origin: string;
        start: string;
        mention?: { documentId: string; text: string };
      };
      const found: MentionItem[] = [];
      let cursor: string | undefined;
      do {
        const page = await authorized.client.callTool({
          name: "temporal_query",
          arguments: {
            from: expected.mention_start_day,
            timeZone: "UTC",
            origins: ["mention"],
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
        });
        expect(page.isError).not.toBe(true);
        const data = (
          page.structuredContent as { data: { items: MentionItem[]; nextCursor?: string } }
        ).data;
        found.push(...data.items);
        cursor = data.nextCursor;
      } while (cursor);

      expect(found.every((item) => item.origin === "mention")).toBe(true);
      expect(
        found.every((item) => item.start === `${expected.mention_start_day}T00:00:00.000Z`),
      ).toBe(true);
      expect(found.map((item) => item.mention?.documentId)).toContain(expected.document_id);

      // Omitting `origins` reads every layer, mentions included; naming the
      // other two leaves them out.
      const defaults = await authorized.client.callTool({
        name: "temporal_query",
        arguments: { from: expected.mention_start_day, timeZone: "UTC", limit: 100 },
      });
      expect(
        (defaults.structuredContent as { data: { items: MentionItem[] } }).data.items.some(
          (item) => item.origin === "mention",
        ),
      ).toBe(true);
      const named = await authorized.client.callTool({
        name: "temporal_query",
        arguments: {
          from: expected.mention_start_day,
          timeZone: "UTC",
          origins: ["projection", "annotation"],
          limit: 100,
        },
      });
      expect(
        (named.structuredContent as { data: { items: MentionItem[] } }).data.items.some(
          (item) => item.origin === "mention",
        ),
      ).toBe(false);
    } finally {
      await closeAuthorized(authorized);
    }
  }, 150_000);

  function oauthClient(
    input: Parameters<typeof authorizeMcpClient>[1],
  ): Promise<AuthorizedMcpClient> {
    return authorizeMcpClient({ gatewayUrl: harness.gatewayUrl, apiKey: harness.apiKey }, input);
  }
});

/**
 * The mention worth gate end to end on a stable gateway: the decision role is
 * served by a scripted stand-in for the TypeSafe endpoint, reached through the production
 * TypeSafe client, extraction queues every document it leaves with a mention,
 * the gate judges each email once and the Direct `temporal_query` leaves out
 * the mentions of email judged not worth recording.
 *
 * The score is scripted: an email whose subject has an even number of
 * characters scores below the threshold, so the corpus splits
 * deterministically. Whether a score is a good judgement is the rubric's
 * evaluation, not this suite's.
 */
describe("temporal query mentions — the worth gate on a stable gateway", () => {
  let harness: SyntheticE2EHarness;
  let decision: DecisionServer;
  /** A throwaway key for the stand-in, which accepts any. */
  const TYPESAFE_KEY = "e2e_typesafe_key_0123456789";
  const LOW = 0.2;
  const HIGH = 2.4;
  const scoreOf = (subject: string): number => (subject.length % 2 === 0 ? LOW : HIGH);

  beforeAll(async () => {
    decision = await startDecisionServer({
      policy: (request: DecisionServerRequest) => ({
        worth_score: {
          type: "score",
          score: scoreOf(String((request.state as { subject?: unknown }).subject)),
        },
      }),
      inputTokens: 700,
    });
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "default",
      extraGatewayEnv: { OMNESIS_TYPESAFE_API_KEY: TYPESAFE_KEY },
      extraInference: {
        allowRemoteInference: true,
        typesafeUrl: decision.endpoint,
        assignments: { decision: `typesafe/${decision.modelId}` },
      },
      extraGatewayConfig: { enrichment: { dates: { worthGate: true } } },
    });
    await harness.start();
    await harness.syncAllSources();
  }, 180_000);

  afterAll(async () => {
    await harness?.destroy();
    await decision?.close();
  }, 15_000);

  test("judges each email once and leaves the mentions of unworthy email out of the time query", async () => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      // Extraction queues, the gate settles: wait until neither has work left.
      const deadline = Date.now() + 120_000;
      for (;;) {
        const { extracting, judging } = db
          .prepare<[], { extracting: number; judging: number }>(
            `SELECT (SELECT COUNT(*) FROM documents WHERE dates_extracted_at IS NULL) AS extracting,
                    (SELECT COUNT(*) FROM date_mention_judgements WHERE verdict = 'pending') AS judging`,
          )
          .get()!;
        if (extracting === 0 && judging === 0) break;
        if (Date.now() > deadline) {
          throw new Error(`Still ${extracting} documents to scan and ${judging} to judge`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const verdicts = db
        .prepare<
          [],
          {
            document_id: string;
            verdict: string;
            score: number | null;
            document_type: string | null;
          }
        >(
          `SELECT j.document_id, j.verdict, j.score,
                  json_extract(d.metadata, '$.documentType') AS document_type
             FROM date_mention_judgements j JOIN documents d ON d.id = j.document_id`,
        )
        .all();
      const dropped = verdicts.filter((v) => v.verdict === "drop");
      const kept = verdicts.filter((v) => v.verdict === "keep");
      expect(dropped.length).toBeGreaterThan(0);
      expect(kept.length).toBeGreaterThan(0);
      // Only email (and attachments, by their email) is judged.
      for (const v of [...dropped, ...kept]) {
        expect(["email", "attachment"]).toContain(v.document_type);
      }
      for (const v of verdicts.filter((row) => row.verdict === "exempt")) {
        expect(v.score).toBeNull();
      }

      // What was sent: the worth rubric's state, with the bearer key, and each
      // email asked about once.
      expect(decision.calls.length).toBeGreaterThan(0);
      const subjects = decision.calls.map((call) => {
        expect(call.authorization).toBe(`Bearer ${TYPESAFE_KEY}`);
        expect(Object.keys(call.request.questions)).toEqual(["worth_score"]);
        expect(Object.keys(call.request.state as object).sort()).toEqual([
          "body",
          "from",
          "subject",
        ]);
        return (call.request.state as { subject: string }).subject;
      });
      expect(decision.calls.length).toBeLessThanOrEqual(kept.length + dropped.length);
      expect(new Set(subjects).size).toBeGreaterThan(0);

      // Its tokens are recorded under their own mechanism.
      const spent = db
        .prepare<
          [],
          { tokens: number | null }
        >(`SELECT SUM(prompt_tokens) AS tokens FROM cognition_spend WHERE mechanism = 'mention-worth-gate'`)
        .get();
      expect(spent?.tokens).toBe(decision.calls.length * 700);

      // A window holding a dropped email's mention.
      const target = db
        .prepare<[], { document_id: string; mention_start_day: string }>(
          `SELECT x.document_id, x.mention_start_day
             FROM document_extracted_dates x
             JOIN date_mention_judgements j ON j.document_id = x.document_id
            WHERE j.verdict = 'drop' AND x.mention_start_day IS NOT NULL
            ORDER BY x.id LIMIT 1`,
        )
        .get();
      if (!target) throw new Error("No dropped email carries a mention");

      const authorized = await authorizeMcpClient(
        { gatewayUrl: harness.gatewayUrl, apiKey: harness.apiKey },
        {
          principalName: "Worth gate assistant",
          grantName: "Worth gate access",
          credentialLabel: "Fictional worth gate desktop",
          capabilities: ["direct"],
        },
      );
      try {
        type Page = {
          items: Array<{ origin: string; mention?: { documentId: string } }>;
          nextCursor?: string;
          coverage: { mentions?: { unworthyHidden?: true } };
        };
        const read = async (extra: Record<string, unknown> = {}): Promise<Page[]> => {
          const pages: Page[] = [];
          let cursor: string | undefined;
          do {
            const result = await authorized.client.callTool({
              name: "temporal_query",
              arguments: {
                from: target.mention_start_day,
                timeZone: "UTC",
                origins: ["mention"],
                limit: 100,
                ...extra,
                ...(cursor ? { cursor } : {}),
              },
            });
            expect(result.isError).not.toBe(true);
            const page = (result.structuredContent as { data: Page }).data;
            pages.push(page);
            cursor = page.nextCursor;
          } while (cursor);
          return pages;
        };
        const window = await read();
        const shown = new Set(window.flatMap((p) => p.items.map((i) => i.mention?.documentId)));
        const droppedIds = new Set(dropped.map((v) => v.document_id));
        expect(shown.has(target.document_id)).toBe(false);
        expect([...shown].some((id) => id && droppedIds.has(id))).toBe(false);
        expect(window[0]!.coverage.mentions?.unworthyHidden).toBe(true);

        // Naming the document reads it whatever its worth.
        const named = await read({ documentIds: [target.document_id] });
        expect(named.flatMap((p) => p.items.map((i) => i.mention?.documentId))).toContain(
          target.document_id,
        );
        expect(named[0]!.coverage.mentions?.unworthyHidden).toBeUndefined();
      } finally {
        await closeAuthorized(authorized);
      }
    } finally {
      db.close();
    }
  }, 240_000);

  test("a note told to Omnesis reaches the time index, read loosely and never judged", async () => {
    // Captured at 00:30 London time on Wednesday 30 September, which is still
    // Tuesday in UTC: "tomorrow" is Thursday 1 October only when counted from
    // the note's own day.
    const captured = await fetch(`${harness.gatewayUrl}/notes`, {
      method: "POST",
      headers: { authorization: `Bearer ${harness.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        text: "Call the plumber tomorrow about the boiler. Book the ferry for next week.",
        capturedAt: "2026-09-29T23:30:00.000Z",
        capturedTimeZoneId: "Europe/London",
        capturedUtcOffsetSeconds: 3600,
        surface: "portal",
      }),
    });
    expect(captured.status).toBeLessThan(300);

    const db = new Database(harness.getDbPath(), { readonly: true });
    let noteId: string;
    try {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const row = db
          .prepare<[], { id: string; scanned: string | null; verdict: string | null }>(
            `SELECT d.id, d.dates_extracted_at AS scanned, j.verdict
               FROM documents d LEFT JOIN date_mention_judgements j ON j.document_id = d.id
              WHERE d.source_id = 'omnesis-notes' AND d.external_id = '2026-09-30'`,
          )
          .get();
        if (row?.scanned && row.verdict && row.verdict !== "pending") {
          // Not an email: exempt, never sent to the decision model.
          expect(row.verdict).toBe("exempt");
          noteId = row.id;
          break;
        }
        if (Date.now() > deadline)
          throw new Error(`Note not scanned and settled: ${JSON.stringify(row)}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      db.close();
    }
    expect(
      decision.calls.some((call) =>
        String((call.request.state as { subject?: unknown }).subject).startsWith("Notes"),
      ),
    ).toBe(false);

    const authorized = await authorizeMcpClient(
      { gatewayUrl: harness.gatewayUrl, apiKey: harness.apiKey },
      {
        principalName: "Note follow-up assistant",
        grantName: "Note follow-up access",
        credentialLabel: "Fictional note desktop",
        capabilities: ["direct"],
      },
    );
    try {
      const mentionsOf = async (from: string, to: string) => {
        const result = await authorized.client.callTool({
          name: "temporal_query",
          arguments: { from, to, timeZone: "Europe/London", origins: ["mention"], limit: 100 },
        });
        expect(result.isError).not.toBe(true);
        return (
          result.structuredContent as {
            data: { items: Array<{ mention?: { documentId: string; text: string } }> };
          }
        ).data.items
          .filter((item) => item.mention?.documentId === noteId)
          .map((item) => item.mention!.text);
      };
      // "tomorrow" lands on Thursday 1 October, not on the UTC date's next day.
      expect(await mentionsOf("2026-10-01", "2026-10-01")).toContain("tomorrow");
      expect(await mentionsOf("2026-09-30", "2026-09-30")).not.toContain("tomorrow");
      // "next week" names no day, yet counts for a note: the week of 5 October.
      expect(await mentionsOf("2026-10-05", "2026-10-11")).toContain("next week");
    } finally {
      await closeAuthorized(authorized);
    }
  }, 120_000);
});

async function closeAuthorized(authorized: AuthorizedMcpClient): Promise<void> {
  const outcomes = await Promise.allSettled([
    authorized.client.close(),
    authorized.transport.close(),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
}
