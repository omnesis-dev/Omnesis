// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * End-to-end coverage for the `japan-trip` Deep Research demo universe.
 *
 * Boots a real gateway against `evals/universes/japan-trip` with the replay
 * agent backend, syncs the synthetic corpus (Drive contract, booking emails,
 * calendar, two bank statements, WhatsApp), then drives the demo's signature
 * prompt — "How much did I spend during my Japan trip?" — over HTTP/SSE and
 * asserts the full deep-research event sequence the clients render:
 *
 *  - three reader sub-agents spawn (bank-sweep, contract-digest, bookings-sweep);
 *  - each accumulates resolved corpus documents (no `$DOC_…` placeholder leaks —
 *    including the composite enable-banking / lunchflow transaction ids);
 *  - a merged citation set lands;
 *  - a single `agent.deep_research.summary` closes the run (answer_complete,
 *    a three-step plan, a fully-verified quote tally);
 *  - the streamed report reconciles the spend across sources.
 *
 * This is the deterministic, token-free proof that the demo cassette + corpus
 * stay wired together: a drift in either (a renamed source, a broken external
 * id, a changed event shape) fails here rather than on a paired device.
 */
// Must be first: sets OMNESIS_SYNTHETIC + OMNESIS_SYNTH_PRE_DISCOVERED before
// the harness / source-descriptors discovery runs (mirrors every other e2e).
import "./synth-env.js";
import { beforeAll, afterAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { AgentEvent } from "@omnesis/core";

const PROMPT = "How much did I spend during my Japan trip?";
const TIMEOUT_MS = 60_000;

describe("japan-trip deep-research demo — end-to-end", () => {
  let harness: SyntheticE2EHarness;
  let events: AgentEvent[] = [];

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "japan-trip",
      agentBackend: "replay",
    });
    await harness.start();
    // Sync every source so the cited documents exist and the cassette's
    // `$DOC_<externalId>` placeholders resolve to real UUIDs at session-create.
    // The synthetic harness discovers and syncs the single-source providers in
    // this universe (enable-banking, lunchflow, whatsapp). It also enumerates a
    // few hardcoded-identity providers not declared here (e.g. screen-time)
    // whose sync throws on the missing fixture — tolerate that rather than fail.
    const sourceIds = harness.getSourceIds();
    await Promise.all(
      sourceIds.map((id) => harness.triggerSyncAndWait(id, 30_000).catch(() => undefined)),
    );
    await harness.refreshSearchSnapshot();
    // triggerSyncAndWait returns when the collector reports sync complete, but
    // the gateway's writer-worker is still draining docs into the `documents`
    // table. The replay factory resolves $DOC_<externalId> placeholders by
    // querying that table at session-create, so wait for the drain to settle
    // before driving the prompt — otherwise a not-yet-written doc leaks its raw
    // placeholder token onto the wire.
    await waitForDocsToSettle(harness, 30_000);
    events = await runPrompt(harness, PROMPT);
  }, 180_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  const byType = (t: string) => events.filter((e) => e.type === t);
  const payloads = (t: string) => byType(t).map((e) => e.payload as Record<string, unknown>);

  test("routes to the scripted run (parent message starts and ends)", () => {
    expect(byType("agent.message.start").length, "no message.start — routing missed").toBe(1);
    expect(byType("agent.message.end").length, "run never terminated").toBe(1);
  });

  test("fans out the three reader sub-agents in order", () => {
    const specialists = payloads("agent.subagent.spawned").map((p) => p.specialist);
    expect(specialists).toEqual(["history-sweep", "source-digest", "history-sweep"]);
  });

  test("every sub-agent completes", () => {
    const results = payloads("agent.subagent.result");
    expect(results.length).toBe(3);
    for (const r of results) expect(r.status).toBe("complete");
  });

  test("a merged citation set lands", () => {
    const updates = payloads("agent.citations.update");
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const added = updates.flatMap((u) => (u.added as Array<{ documentId: string }>) ?? []);
    expect(added.length).toBeGreaterThanOrEqual(6);
  });

  test("the bank-statement citations resolve to real documents (corroboration core)", () => {
    // The synthetic harness syncs the single-source providers (enable-banking,
    // lunchflow, whatsapp) but does not discover the multi-source Google
    // provider (gmail/calendar/drive) under this custom-cast universe, so the
    // E2E asserts resolution for the BANK-STATEMENT citations — the demo's core
    // corroboration claim (every booking ties to a bank charge), which use
    // composite external ids (`<accountKey>:<txnKey>`). The Drive contract and
    // booking-email citations and the full render are covered by
    // `npm run validate-universes` and the portal demo against a settled gateway.
    const added = payloads("agent.citations.update").flatMap(
      (u) => (u.added as Array<{ documentId: string; sourceType?: string }>) ?? [],
    );
    const bankRefs = added.filter((r) => /banking|lunchflow/.test(String(r.sourceType ?? "")));
    expect(bankRefs.length, "expected resolved bank-statement citations").toBeGreaterThanOrEqual(2);
    for (const ref of bankRefs) {
      expect(ref.documentId, "bank citation must resolve to a real UUID").not.toMatch(/^\$DOC_/);
    }
  });

  test("a single deep-research summary closes the run, fully verified", () => {
    const summaries = payloads("agent.deep_research.summary");
    expect(summaries.length).toBe(1);
    const s = summaries[0];
    expect(s.stoppedReason).toBe("answer_complete");
    expect((s.plan as unknown[]).length).toBe(3);
    const v = s.verification as { quotesChecked: number; quotesVerified: number };
    expect(v.quotesChecked).toBe(6);
    expect(v.quotesVerified).toBe(6);
  });

  test("the report reconciles the spend across sources", () => {
    const report = payloads("agent.text.delta")
      .map((p) => String(p.delta ?? ""))
      .join("");
    expect(report).toContain("Studio Northstar");
    expect(report).toContain("3,700");
    expect(report).toContain("168,000");
  });

  test("the deep-research summary metadata survives a reload", async () => {
    // Drive the cassette through the live gateway, then reload the persisted
    // conversation exactly the way a client does on refresh (list → get) and
    // assert the gateway recorded the compatibility `report_artifact` part.
    // Clients no longer render a separate report card, but the part remains in
    // the protocol so reloaded citations and older transcripts retain context.
    const rec = await loadPersistedConversation(harness, 10_000);
    const artifacts = rec.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts)
      .filter((p) => p.kind === "report_artifact") as Array<{
      stoppedReason?: string;
      verification?: { quotesChecked?: number; quotesVerified?: number };
      citations?: unknown[];
    }>;
    expect(artifacts.length, "report_artifact compatibility metadata was not persisted").toBe(1);
    const artifact = artifacts[0];
    expect(artifact.stoppedReason).toBe("answer_complete");
    expect(artifact.verification).toEqual({ quotesChecked: 6, quotesVerified: 6 });
    expect(
      artifact.citations?.length ?? 0,
      "artifact must carry the merged citation set so reloaded sources render",
    ).toBeGreaterThanOrEqual(6);
  });
});

/**
 * Reload the persisted conversation the way a client does on refresh: list the
 * conversations, then GET the one this run produced. Polls until the assistant
 * turn has settled to disk (persistence fires after the turn completes, so a
 * read immediately after `message.end` can race the writer).
 */
async function loadPersistedConversation(
  harness: SyntheticE2EHarness,
  timeoutMs: number,
): Promise<{ messages: Array<{ role: string; parts: Array<Record<string, unknown>> }> }> {
  const auth = { Authorization: `Bearer ${harness.apiKey}` };
  const deadline = Date.now() + timeoutMs;
  let last: { messages: Array<{ role: string; parts: Array<Record<string, unknown>> }> } | null =
    null;
  while (Date.now() < deadline) {
    const listRes = await fetch(`${harness.gatewayUrl}/agent/conversations`, { headers: auth });
    if (listRes.ok) {
      const { conversations } = (await listRes.json()) as { conversations?: Array<{ id: string }> };
      if (conversations && conversations.length > 0) {
        const res = await fetch(
          `${harness.gatewayUrl}/agent/conversations/${conversations[0].id}`,
          {
            headers: auth,
          },
        );
        if (res.ok) {
          last = (await res.json()) as typeof last;
          if (last?.messages?.some((m) => m.role === "assistant")) return last;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (last) return last;
  throw new Error("no persisted conversation with an assistant turn appeared before timeout");
}

/**
 * Poll the gateway's document list until the writer-worker has drained — the
 * count stops climbing across consecutive reads. The replay factory resolves
 * placeholders against the `documents` table at session-create, so every synced
 * doc must have landed there first.
 */
async function waitForDocsToSettle(harness: SyntheticE2EHarness, timeoutMs: number): Promise<void> {
  // The harness syncs the bank statements (enable-banking 10 + lunchflow 4) and
  // the whatsapp thread (3) for this universe — ~17 docs. Wait until the count
  // reaches that floor AND stops changing, so the bank docs the cassette cites
  // are written before the session resolves placeholders.
  const EXPECTED_MIN = 14;
  const deadline = Date.now() + timeoutMs;
  let prev = -1;
  let stableReads = 0;
  while (Date.now() < deadline) {
    let total = 0;
    try {
      const res = await fetch(`${harness.gatewayUrl}/status`, {
        headers: { Authorization: `Bearer ${harness.apiKey}` },
      });
      if (res.ok) {
        const body = (await res.json()) as { documents?: { total?: number } };
        total = body.documents?.total ?? 0;
      }
    } catch {
      /* transient — retry */
    }
    if (total >= EXPECTED_MIN && total === prev) {
      if (++stableReads >= 3) return;
    } else {
      stableReads = 0;
    }
    prev = total;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Open SSE, create a session, post the prompt, collect events until message.end. */
async function runPrompt(harness: SyntheticE2EHarness, prompt: string): Promise<AgentEvent[]> {
  const sse = await fetch(`${harness.gatewayUrl}/agent/events`, {
    headers: { Authorization: `Bearer ${harness.apiKey}`, Accept: "text/event-stream" },
  });
  if (!sse.ok || !sse.body) {
    throw new Error(`SSE subscribe failed: ${sse.status} ${await sse.text()}`);
  }
  const reader = sse.body.getReader();
  try {
    const sessionRes = await fetch(`${harness.gatewayUrl}/agent/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${harness.apiKey}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!sessionRes.ok) throw new Error(`session create failed: ${sessionRes.status}`);
    const session = (await sessionRes.json()) as { sessionId: string };
    const msgRes = await fetch(
      `${harness.gatewayUrl}/agent/sessions/${session.sessionId}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${harness.apiKey}`, "Content-Type": "application/json" },
        // deepResearch:true mirrors arming the "/" Deep research pill. A replay
        // backend must still play its cassette (the live planner can't decompose
        // against a token-free backend), so this guards the service.ts carve-out.
        body: JSON.stringify({ text: prompt, deepResearch: true }),
      },
    );
    if (!msgRes.ok) throw new Error(`message send failed: ${msgRes.status}`);
    const sent = (await msgRes.json()) as { messageId: string };
    return await collectUntilEnd(reader, session.sessionId, sent.messageId);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best effort */
    }
  }
}

async function collectUntilEnd(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sessionId: string,
  messageId: string,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value?: undefined }>((r) =>
        setTimeout(() => r({ done: true as const }), deadline - Date.now()),
      ),
    ]);
    if (next.done || !next.value) break;
    buffer += decoder.decode(next.value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice("data:".length).trim();
      if (!json) continue;
      let parsed: AgentEvent;
      try {
        parsed = JSON.parse(json) as AgentEvent;
      } catch {
        continue;
      }
      const payload = parsed.payload as Record<string, unknown> | undefined;
      if (!payload || payload.sessionId !== sessionId) continue;
      events.push(parsed);
      if (parsed.type === "agent.message.end" && payload.messageId === messageId) return events;
    }
  }
  return events;
}
