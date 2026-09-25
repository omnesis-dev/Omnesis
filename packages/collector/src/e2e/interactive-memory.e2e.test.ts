// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { SyntheticE2EHarness } from "./synth-harness.js";
import {
  startOpenAiServer,
  type OpenAiServerHandle,
  type WireMessage,
  type WireReply,
} from "./brain-bench/openai-server.js";

const PREFERENCE = "I prefer morning meetings.";
const PERSON_FACT = "Jamie Lopez is my hiking partner.";
const DOCUMENT_FACT = "The packing checklist is for the autumn hike.";
const ASSISTANT_ONLY = "The user owns a purple sailing boat.";
const CREATE = `Remember these facts: ${PREFERENCE} ${PERSON_FACT} ${DOCUMENT_FACT}`;
const CORRECTION = "Correction: I now prefer afternoon meetings.";
const CORRECTED_QUOTE = "I now prefer afternoon meetings.";
const RECALL = "Recall my meeting preference in this fresh conversation.";
const FORGET = "Forget the hiking relationship and checklist context.";
const DONE = "Scripted memory turn complete.";

type Result = Record<string, unknown>;
type PlannedCall = (results: Result[]) => { name: string; args: Record<string, unknown> };
interface Annotation {
  id: string;
  claimText: string;
  evidenceDocId: string;
}
interface StoredConversation {
  messages: Array<{ role: string; parts: Array<{ kind: string; text?: string; result?: Result }> }>;
}

/** The only substitution is the agent's HTTP model. Plans emit actual tool
 * calls and consume actual results from the spawned stable gateway. */
describe("interactive durable memory without the experimental Brain", () => {
  let harness: SyntheticE2EHarness;
  let model: OpenAiServerHandle;
  let db: Database.Database;
  let selfId: string;
  let personId: string;
  let targetDocId: string;
  let recalledSystemPrompt = "";
  let creationSystemPrompt = "";
  const plans = new Map<string, PlannedCall[]>();
  const observed = new Map<string, Result[]>();

  beforeAll(async () => {
    model = await startOpenAiServer({
      modelId: "scripted-interactive-memory",
      respond: (messages): WireReply => {
        const userIndex = messages.findLastIndex((message) => message.role === "user");
        const prompt = messages[userIndex]?.content ?? "";
        if (prompt === "Produce the fictional assistant-only sentence.") {
          return { kind: "text", text: ASSISTANT_ONLY };
        }
        if (prompt === RECALL) {
          recalledSystemPrompt = messages
            .filter((message) => message.role === "system")
            .map((message) => message.content ?? "")
            .join("\n");
          return { kind: "text", text: DONE };
        }
        if (prompt === CREATE) {
          creationSystemPrompt = messages
            .filter((message) => message.role === "system")
            .map((message) => message.content ?? "")
            .join("\n");
        }
        const plan = plans.get(prompt);
        if (!plan) return { kind: "text", text: "Scripted model ready." };
        const results = toolResults(messages.slice(userIndex + 1));
        observed.set(prompt, results);
        const step = plan[results.length];
        return step ? { kind: "tool", ...step(results) } : { kind: "text", text: DONE };
      },
    });
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      extraInference: {
        backends: { memory: { type: "http", url: model.url } },
        assignments: { agent: `memory/${model.modelId}` },
      },
      extraGatewayConfig: { self: { name: "Maya Reeves", emails: ["maya@example.com"] } },
      // Keep production debouncing: the memory evidence tool must flush the
      // current turn itself, before the turn-complete observer runs.
      extraGatewayEnv: { OMNESIS_CHAT_DEBOUNCE_MS: "30000" },
    });
    await harness.start();
    await harness.pushDocument({
      externalId: "memory-packing-checklist",
      title: "Packing checklist",
      content: "Packing checklist: boots, water, and a map.",
      metadata: {
        people: [{ name: "Jamie Lopez", emails: ["jamie@example.com"], role: "author" }],
      },
    });
    db = new Database(harness.getDbPath(), { readonly: true });
    selfId = requireId(
      db.prepare<[], { id: string }>("SELECT id FROM people WHERE is_self = 1").get(),
    );
    targetDocId = requireId(
      db
        .prepare<
          [],
          { id: string }
        >("SELECT id FROM documents WHERE external_id = 'memory-packing-checklist'")
        .get(),
    );
    // Document ingestion commits before the background people-resolution
    // writer has built its person rows. Await that production boundary.
    const personQuery = db.prepare<[], { id: string }>(
      "SELECT id FROM people WHERE canonical_name = 'Jamie Lopez'",
    );
    await vi.waitFor(() => expect(personQuery.get()?.id).toBeTruthy(), {
      timeout: 60_000,
      interval: 100,
    });
    personId = requireId(personQuery.get());
  }, 240_000);

  afterAll(async () => {
    db?.close();
    await harness?.destroy();
    await model?.close();
  }, 60_000);

  test("creates, retrieves, corrects, forgets, and cascades evidence-grounded memories in stable mode", async () => {
    const status = await harness.gatewayJson<{ experimental: boolean }>("/status");
    expect(status.experimental).toBe(false);
    const sessionId = await createSession(harness);
    await runTurn(
      harness,
      sessionId,
      "Produce the fictional assistant-only sentence.",
      ASSISTANT_ONLY,
    );

    const base = (quote: string, claimType: string): Record<string, unknown> => ({
      claimType,
      claimText: quote,
      evidenceQuote: quote,
      confidence: 0.9,
      claimBasis: "quoted",
    });
    const evidenceId = (results: Result[]): string => {
      const data = results[0]?.data as { documentId?: string; userMessages?: string[] } | undefined;
      if (!data?.documentId)
        throw new Error(`No conversation evidence: ${JSON.stringify(results[0])}`);
      return data.documentId;
    };
    plans.set(CREATE, [
      () => ({ name: "conversation_memory_evidence", args: {} }),
      (results) => ({
        name: "annotate_person",
        args: {
          ...base(PREFERENCE, "meeting_preference"),
          personId: selfId,
          evidenceDocId: evidenceId(results),
        },
      }),
      (results) => ({
        name: "annotate_person",
        args: {
          ...base(PERSON_FACT, "hiking_relationship"),
          personId,
          evidenceDocId: evidenceId(results),
        },
      }),
      (results) => ({
        name: "annotate_durable",
        args: {
          ...base(DOCUMENT_FACT, "trip_context"),
          docId: targetDocId,
          evidenceDocId: evidenceId(results),
        },
      }),
      (results) => ({
        name: "annotate_person",
        args: {
          ...base("The user prefers midnight meetings.", "fabricated_preference"),
          personId: selfId,
          evidenceDocId: evidenceId(results),
        },
      }),
      (results) => ({
        name: "annotate_person",
        args: {
          ...base(ASSISTANT_ONLY, "assistant_testimony"),
          personId: selfId,
          evidenceDocId: evidenceId(results),
        },
      }),
      (results) => ({
        name: "annotate_person",
        args: {
          ...base(PREFERENCE, "mixed_testimony"),
          personId: selfId,
          evidenceDocId: evidenceId(results),
          additionalEvidence: [{ docId: evidenceId(results), quote: ASSISTANT_ONLY }],
        },
      }),
    ]);
    await runTurn(harness, sessionId, CREATE);
    expect(creationSystemPrompt).toContain(
      `The user's self person ID is ${JSON.stringify(selfId)}`,
    );
    const results = observed.get(CREATE)!;
    expect(results).toHaveLength(7);
    const prepared = results[0]?.data as { documentId: string; userMessages: string[] };
    expect(prepared.userMessages).toContain(CREATE);
    expect(prepared.userMessages.join("\n")).not.toContain(ASSISTANT_ONLY);
    for (const result of results.slice(1, 4))
      expect(result.kind, JSON.stringify(result)).not.toBe("error");
    expect(results[4]).toMatchObject({ kind: "error", code: "evidence_not_found" });
    expect(results[5]).toMatchObject({ kind: "error", code: "invalid_evidence" });
    expect(results[6]).toMatchObject({ kind: "error", code: "invalid_evidence" });

    const self = await annotations(harness, `/people/${selfId}/annotations`);
    const person = await annotations(harness, `/people/${personId}/annotations`);
    const document = await annotations(harness, `/documents/${targetDocId}/annotations`);
    expect(self.map((row) => row.claimText)).toEqual([PREFERENCE]);
    expect(person.map((row) => row.claimText)).toEqual([PERSON_FACT]);
    expect(document.map((row) => row.claimText)).toEqual([DOCUMENT_FACT]);
    expect(self[0]?.evidenceDocId).toBe(prepared.documentId);
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_runs").get()?.n).toBe(
      0,
    );

    const fresh = await createSession(harness);
    await runTurn(harness, fresh, RECALL);
    expect(recalledSystemPrompt).toContain(PREFERENCE);
    expect(recalledSystemPrompt).not.toContain(ASSISTANT_ONLY);

    plans.set(CORRECTION, [
      () => ({ name: "conversation_memory_evidence", args: {} }),
      (items) => ({
        name: "annotate_person",
        args: {
          ...base(CORRECTED_QUOTE, "meeting_preference"),
          personId: selfId,
          evidenceDocId: evidenceId(items),
          supersedes: self[0]!.id,
        },
      }),
    ]);
    await runTurn(harness, sessionId, CORRECTION);
    const corrected = await annotations(harness, `/people/${selfId}/annotations`);
    expect(corrected.map((row) => row.claimText)).toEqual([CORRECTED_QUOTE]);

    plans.set(FORGET, [
      () => ({ name: "person_annotation_retract", args: { id: person[0]!.id } }),
      () => ({ name: "annotation_retract", args: { id: document[0]!.id } }),
    ]);
    await runTurn(harness, sessionId, FORGET);
    expect(await annotations(harness, `/people/${personId}/annotations`)).toEqual([]);
    expect(await annotations(harness, `/documents/${targetDocId}/annotations`)).toEqual([]);

    await harness.restartGateway();
    expect((await harness.gatewayJson<{ experimental: boolean }>("/status")).experimental).toBe(
      false,
    );
    await runTurn(harness, await createSession(harness), RECALL);
    expect(recalledSystemPrompt).toContain(CORRECTED_QUOTE);
    expect(recalledSystemPrompt).not.toContain(PREFERENCE);

    // Deleting the original conversation removes its evidence and every
    // derivative, including the superseded row's retained audit text.
    await harness.gatewayJson(`/agent/conversations/${sessionId}`, { method: "DELETE" });
    expect(await annotations(harness, `/people/${selfId}/annotations`)).toEqual([]);
    expect(
      db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM person_annotations WHERE evidence_doc_id = ?")
        .get(prepared.documentId)?.n,
    ).toBe(0);
    expect(
      db
        .prepare<[string], { id: string }>("SELECT id FROM documents WHERE id = ?")
        .get(prepared.documentId),
    ).toBeUndefined();
  }, 180_000);
});

function toolResults(messages: readonly WireMessage[]): Result[] {
  return messages
    .filter((message) => message.role === "tool")
    .map((message) => {
      const value: unknown = JSON.parse(message.content ?? "null");
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Unexpected tool result");
      return value as Result;
    });
}

function requireId(row: { id: string } | undefined): string {
  if (!row) throw new Error("Missing fictional fixture entity");
  return row.id;
}

async function createSession(harness: SyntheticE2EHarness): Promise<string> {
  const created = await harness.gatewayJson<{ sessionId: string }>("/agent/sessions", {
    method: "POST",
    body: "{}",
  });
  return created.sessionId;
}

async function annotations(harness: SyntheticE2EHarness, path: string): Promise<Annotation[]> {
  return (await harness.gatewayJson<{ annotations: Annotation[] }>(path)).annotations;
}

/** Wait for the durable transcript, not the earlier terminal stream event:
 * the next turn and deletion must not race turn-completion persistence. */
async function runTurn(
  harness: SyntheticE2EHarness,
  sessionId: string,
  text: string,
  answer = DONE,
): Promise<void> {
  await harness.gatewayJson(`/agent/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
  await expect
    .poll(
      async () => {
        const response = await fetch(`${harness.gatewayUrl}/agent/conversations/${sessionId}`, {
          headers: { Authorization: `Bearer ${harness.apiKey}` },
        });
        if (response.status === 404) return false;
        if (!response.ok) throw new Error(`Conversation read failed: ${response.status}`);
        const record = (await response.json()) as StoredConversation;
        const latestUser = record.messages.findLast(
          (message) =>
            message.role === "user" && message.parts.some((part) => part.kind === "text"),
        );
        const last = record.messages.at(-1);
        return (
          latestUser?.parts.some((part) => part.text === text) === true &&
          last?.role === "assistant" &&
          last.parts.some((part) => part.text === answer)
        );
      },
      { timeout: 30_000, interval: 100 },
    )
    .toBe(true);
}
