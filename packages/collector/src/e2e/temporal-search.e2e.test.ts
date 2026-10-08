// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The search temporal lane end to end: a real gateway with
 * `search.temporal.enabled`, documents pushed over HTTP, the date-enrichment
 * task reading their mentions into the time index, and `POST /search` fusing
 * the lane through the search worker.
 *
 * Each scenario holds the text lanes constant and lets only the lane differ:
 * the same query is asked with the lane and with a per-request override that
 * turns it off. Older documents that repeat the query's words outrank the
 * right one on words alone; the lane lifts the one the query's time names —
 * by when it was sent (document time) or by the date it is about (event time,
 * from a mention the gateway extracted).
 */

import "./synth-env.js";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { SyntheticE2EHarness } from "./synth-harness.js";

const DAY_MS = 86_400_000;
const ZONE = "UTC";

interface SearchResponse {
  results: Array<{ title: string; scoreBreakdown?: { temporalRank?: number } }>;
  query: { temporal?: { windows: Array<{ start: string; endExclusive: string; text: string }> } };
  stages?: { temporal?: { status: string; eventDocuments?: number; candidates?: number } };
}

/** "14 October 2026" for a UTC day. */
function spoken(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: ZONE,
  }).format(new Date(ms));
}

function utcMidnight(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

const now = Date.now();
const today = utcMidnight(now);
const sentDay = today - 10 * DAY_MS;
const eventDay = today + 9 * DAY_MS;

const iso = (ms: number) => new Date(ms).toISOString();

// Invented corpus. Every invoice and every dentist note repeats the query's
// words, so ranking by words alone cannot single out the one the time names.
const CORPUS = [
  {
    externalId: "invoice-old-1",
    title: "Garden works invoice from Brightmoor, invoice enclosed",
    content: "Invoice for the garden works at Brightmoor. Invoice total due on receipt.",
    sourceCreatedAt: iso(today - 200 * DAY_MS),
  },
  {
    externalId: "invoice-old-2",
    title: "Reminder: invoice from Brightmoor, invoice unpaid",
    content: "Reminder: invoice for Brightmoor garden works remains unpaid. Invoice attached.",
    sourceCreatedAt: iso(today - 150 * DAY_MS),
  },
  {
    externalId: "invoice-sent-day",
    title: "Brightmoor statement",
    content: "Please find the invoice for the hedge trimming at Brightmoor.",
    sourceCreatedAt: iso(sentDay + 9 * 3_600_000),
  },
  {
    externalId: "dentist-old-1",
    title: "Dentist appointment Northstar dentist",
    content: "Dentist checkup at Northstar dental. Dentist reminder for the cleaning.",
    sourceCreatedAt: iso(today - 120 * DAY_MS),
  },
  {
    externalId: "dentist-old-2",
    title: "Dentist follow-up Northstar dentist",
    content: "Dentist follow-up visit at Northstar dental after the dentist checkup.",
    sourceCreatedAt: iso(today - 90 * DAY_MS),
  },
  {
    externalId: "dentist-event",
    title: "Booking confirmed",
    content: `Your dentist appointment at Northstar is confirmed for ${spoken(eventDay)} at 10:00.`,
    sourceCreatedAt: iso(today - 20 * DAY_MS),
  },
];

describe("search temporal lane (real gateway)", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      // The indexer chunks documents once an embedder is attached; the fake
      // one is deterministic and keeps the semantic lanes from deciding ranks.
      embedderBackend: "fake",
      extraGatewayConfig: {
        gateway: { searchWorker: { concurrency: 1 } },
        search: { temporal: { enabled: true } },
      },
    });
    await harness.start();
    await harness.pushDocuments(CORPUS);
    await waitFor("indexed documents", async () => {
      await harness.refreshSearchSnapshot();
      const invoices = await search("Brightmoor", false);
      const dentists = await search("Northstar", false);
      return invoices.results.length >= 3 && dentists.results.length >= 3;
    });
    await waitFor("the event date in the time index", async () => {
      const window = await harness.gatewayJson<{ items: Array<{ mention?: { text: string } }> }>(
        `/temporal/window?from=${eventDay}&to=${eventDay + DAY_MS}&timeZone=${ZONE}&origins=mention`,
      );
      return window.items.some((i) => i.mention);
    });
    await harness.refreshSearchSnapshot();
  }, 300_000);

  afterAll(async () => {
    await harness?.destroy();
  }, 30_000);

  async function waitFor(what: string, ready: () => Promise<boolean>, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await ready()) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`temporal-search.e2e: timed out waiting for ${what}`);
  }

  function search(text: string, temporal: boolean): Promise<SearchResponse> {
    return harness.gatewayJson<SearchResponse>("/search", {
      method: "POST",
      // The fake embedder's vectors carry no meaning, so the vector lane
      // ranks arbitrarily; a heavier lane weight keeps that noise from
      // deciding which document leads.
      body: JSON.stringify({
        text,
        limit: 10,
        timeZone: ZONE,
        temporal: temporal ? { enabled: true, weight: 3 } : { enabled: false },
      }),
    });
  }

  test("document time: the invoice sent on the named day rises to the top", async () => {
    const text = `Brightmoor invoice ${spoken(sentDay)}`;
    const without = await search(text, false);
    expect(without.stages?.temporal).toBeUndefined();
    expect(without.results[0]?.title).not.toBe("Brightmoor statement");

    const withLane = await search(text, true);
    expect(withLane.query.temporal?.windows).toEqual([
      { start: iso(sentDay), endExclusive: iso(sentDay + DAY_MS), text: spoken(sentDay) },
    ]);
    expect(withLane.stages?.temporal?.status).toBe("ran");
    expect(withLane.results[0]?.title).toBe("Brightmoor statement");
    expect(withLane.results[0]?.scoreBreakdown?.temporalRank).toBe(1);
  });

  test("event time: the booking about the named day rises, though sent weeks earlier", async () => {
    const text = `dentist Northstar ${spoken(eventDay)}`;
    const withLane = await search(text, true);
    expect(withLane.stages?.temporal?.eventDocuments).toBeGreaterThanOrEqual(1);
    // The lane reaches the booking only through the date it mentions: it was
    // sent weeks before the window.
    const booking = withLane.results.find((r) => r.title === "Booking confirmed");
    expect(booking?.scoreBreakdown?.temporalRank).toBe(1);
    expect(withLane.results[0]?.title).toBe("Booking confirmed");
    for (const r of withLane.results.filter((r) => r.title !== "Booking confirmed")) {
      expect(r.scoreBreakdown?.temporalRank).toBeUndefined();
    }
  });

  test("a query that names no time is answered by the text lanes alone", async () => {
    const r = await search("Brightmoor invoice", true);
    expect(r.stages?.temporal).toBeUndefined();
    expect(r.query.temporal).toBeUndefined();
    expect(r.results.length).toBeGreaterThan(0);
  });
});
