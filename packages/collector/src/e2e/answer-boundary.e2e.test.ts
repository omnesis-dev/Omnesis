// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The REST Answer boundary, as an off-host integration actually meets it.
 *
 * `POST /answer` is the raw privacy-brokered ask: a durable, idempotent task
 * whose generation is deliberately not bound to the caller's socket — the route
 * hands `c.req.raw.signal` to the release seam only, never into
 * `service.answer`. Three promises hang off that decision, and each of them is
 * a property of the composition rather than of any one function's decision
 * table, which is why they belong here.
 *
 * A repeat of a `clientRequestId` still in flight is a poll: it attaches to the
 * running task, starts no second turn, and is never measured against the
 * per-owner turn limit — otherwise a caller following the documented retry
 * contract locks itself out with its own in-flight ask. A caller that
 * disappears mid-turn must lose no work and claim no disclosure: the turn
 * commits, and the egress ledger stays empty until something live collects the
 * bytes. And `approval: "never"` — the route's own default, so the shape every
 * unattended integration gets — has to turn every reviewer outcome that is not
 * `allow` or `deny` into one denial that keeps no candidate, mints no approval
 * and writes no release.
 *
 * The decision logic behind all three is already pinned by units:
 * `answer-service.test.ts` drives a poll at a one-turn owner limit against a
 * fake agent, and `agent.test.ts` drives both the 409 and the disconnect
 * against the real Hono app with an in-process store. What those cannot reach
 * is everything they fake away, and that is what is here: the real per-owner
 * default of two concurrent turns with two genuinely concurrent asks behind one
 * writer worker; the durable audit and egress ledger read out of SQLite rather
 * than a spy on `recordEgress`; a socket that really dies, so the abort comes
 * from `@hono/node-server`'s own `outgoing.on("close")` wiring rather than from
 * an `AbortController` handed to `app.request`; and the whole-install
 * `not_configured` state, which is composed of the inference registry,
 * `resolveRoleBackend` and the reviewer, and is the one failure that is every
 * answer on an install rather than one unlucky answer.
 *
 * Only the reviewer model is substituted, at the production HTTP-backend seam
 * (`inference.backends` plus `assignments["privacy-reviewer"]`, the same seam
 * the brain bench uses for its gates). Substituting it is what makes time an
 * input instead of a hazard: a scripted reviewer that holds its answer open
 * keeps a task in `running` for exactly as long as a test needs, so nothing
 * here waits on a duration. The agent that writes the candidate is the
 * universe's own replay cassette set, and route, scopes, writer, store, audit
 * and egress ledger are all production code.
 */

import "./synth-env.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { DEFAULT_MAX_CONCURRENT_ANSWERS_PER_OWNER } from "@omnesis/gateway/src/privacy/answer-service.js";
import { DENIED_TRANSCRIPT_MARKER } from "@omnesis/gateway/src/privacy/store-types.js";
import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";
import { loginPortal, portalJson, portalRequest } from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

/** Where `agentBackend: "replay"` points the spawned gateway. */
const AGENT_DEMOS = join(
  import.meta.dirname,
  "../../../..",
  "evals",
  "universes",
  "default",
  "agent-demos",
);

interface Cassette {
  /** The scenario's own routing trigger, asked verbatim as the external question. */
  question: string;
  /** The text it replays — exactly what the answer turn accumulates as its candidate. */
  draft: string;
}

/**
 * Read a privacy scenario out of the universe rather than restating it.
 *
 * Asking a scenario's own declared trigger is what makes routing unambiguous:
 * a renamed trigger fails here instead of quietly routing the question to a
 * different cassette and leaving every assertion below measuring the wrong
 * draft. Comparing a release against the fixture's own text rather than a
 * literal keeps the claim the right one — an allowed release is byte-identical
 * to what the agent generated — instead of pinning the corpus's prose.
 */
function loadCassette(name: string): Cassette {
  const meta = JSON.parse(readFileSync(join(AGENT_DEMOS, `${name}.meta.json`), "utf8")) as {
    triggers?: string[];
  };
  const question = meta.triggers?.[0];
  if (!question) throw new Error(`cassette ${name} declares no trigger`);
  let draft = "";
  for (const line of readFileSync(join(AGENT_DEMOS, `${name}.jsonl`), "utf8").split("\n")) {
    const raw = line.trim();
    if (raw === "" || raw.startsWith("#")) continue;
    const entry = JSON.parse(raw) as {
      event?: { type?: string; payload?: { delta?: string } };
    };
    if (entry.event?.type === "agent.text.delta") draft += entry.event.payload?.delta ?? "";
  }
  if (draft === "") throw new Error(`cassette ${name} replays no text`);
  return { question, draft };
}

/**
 * Four privacy scenarios, each answering one of these tests' questions. They
 * also key the scripted reviewer: the envelope it receives quotes
 * `currentRequest` verbatim, so the question is the rule's name.
 */
const SUPPLIER = loadCassette("privacy-supplier-digest");
const DELIVERY = loadCassette("privacy-delivery-window");
const TENANCY = loadCassette("privacy-tenancy-deposit");
const MEMBER = loadCassette("privacy-member-reference");

/** Wall-clock ceilings. Generous, because a sibling E2E file may share the box. */
const DB_WAIT = { timeout: 60_000, interval: 200 } as const;
const COUNTER_WAIT = { timeout: 30_000, interval: 50 } as const;

// ── scripted privacy reviewer ────────────────────────────────────────────────

interface WireMessage {
  role: string;
  content: string | null;
}

interface ScriptedFinding {
  category: string;
  detailLevel: "existence" | "summary" | "exact" | "original";
  subject: "user" | "other_person" | "multiple_people" | "unknown";
  disposition: "allow" | "reduce" | "approval" | "deny";
  description: string;
}

interface ScriptedSubmission {
  decision: "allow" | "reduce" | "ask" | "deny";
  confidence: number;
  findings: ScriptedFinding[];
  rationale: string;
}

/** What the scripted reviewer answers one review call with. */
type ScriptedVerdict =
  /** A `submit_privacy_review` tool call carrying this verdict. */
  | { kind: "submit"; review: ScriptedSubmission }
  /** Plain prose and no tool call at all — the reviewer that never submits. */
  | { kind: "text"; text: string };

interface ScriptedReviewer {
  url: string;
  modelId: string;
  /** Arm the verdict for one question. */
  script(question: string, verdict: ScriptedVerdict): void;
  /** Park the next review of this question until {@link release}. */
  hold(question: string): void;
  release(question: string): void;
  releaseAll(): void;
  /** Reviews of this question currently parked on a gate. */
  pending(question: string): number;
  /** Review calls served for this question — every model consultation. */
  servedCalls(question: string): number;
  /** Tool-call replies actually handed back for this question. */
  submissions(question: string): number;
  /** The privacy policy revision each review of this question was shown, in order. */
  policyRevisions(question: string): readonly string[];
  /** Envelopes whose `currentRequest` matched no scripted question. */
  unmatched(): readonly string[];
  closeAllConnections(): void;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * An OpenAI-compatible chat server standing in for the privacy reviewer.
 *
 * It differs from the brain bench's scripted server in the one way this file
 * needs: a review can be *parked*. Parking is what turns "a task is running"
 * from a duration into a state the test owns — the gate is closed until the
 * test opens it, and 120s of `ORDINARY_HTTP_TIMEOUT_MS` is the only bound.
 *
 * Streaming is answered with a request-shape 400 so `HttpChatBackend`'s
 * resilience ladder falls to the non-streamed shape this server speaks. The
 * message deliberately avoids "not a chat model" and "v1/responses": either
 * phrase would send the whole turn down `OpenAIResponsesBackend` instead.
 */
async function startScriptedReviewer(): Promise<ScriptedReviewer> {
  const modelId = "scripted-privacy-reviewer";
  const rules = new Map<string, ScriptedVerdict>();
  const gates = new Map<string, { promise: Promise<void>; open: () => void }>();
  const parked = new Map<string, number>();
  const served = new Map<string, number>();
  const submitted = new Map<string, number>();
  const unmatchedRequests: string[] = [];
  const reviewedRevisions = new Map<string, string[]>();
  let counter = 0;

  const bump = (counters: Map<string, number>, key: string, by: number): void => {
    counters.set(key, (counters.get(key) ?? 0) + by);
  };

  /**
   * The envelope's `currentRequest` — the external question, quoted verbatim —
   * and the revision of the privacy policy the review applies.
   */
  const envelopeOf = (messages: readonly WireMessage[]): { question: string; revision: string } => {
    const payload = messages.find((m) => m.role === "user")?.content;
    if (typeof payload !== "string") return { question: "", revision: "" };
    try {
      const envelope = JSON.parse(payload) as {
        currentRequest?: unknown;
        userPolicy?: { revision?: unknown };
      };
      return {
        question: typeof envelope.currentRequest === "string" ? envelope.currentRequest : "",
        revision:
          typeof envelope.userPolicy?.revision === "string" ? envelope.userPolicy.revision : "",
      };
    } catch {
      return { question: "", revision: "" };
    }
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      if (req.method === "GET" && url.startsWith("/v1/models")) {
        json(res, 200, {
          object: "list",
          data: [{ id: modelId, object: "model", owned_by: "omnesis-answer-boundary-e2e" }],
        });
        return;
      }
      if (req.method !== "POST" || !url.startsWith("/v1/chat/completions")) {
        json(res, 404, { error: { message: `no route for ${req.method} ${url}` } });
        return;
      }

      const raw = await readBody(req);
      let body: { stream?: unknown; messages?: WireMessage[] } | null;
      try {
        body = JSON.parse(raw) as { stream?: unknown; messages?: WireMessage[] };
      } catch {
        body = null;
      }
      if (!body || !Array.isArray(body.messages)) {
        json(res, 400, { error: { message: "malformed request body" } });
        return;
      }
      if (body.stream === true) {
        json(res, 400, {
          error: { message: "stream is not supported by the scripted privacy-reviewer server" },
        });
        return;
      }

      // A turn carrying a tool result is the reviewer reading back its own
      // accepted submission; ending it with prose is what closes the session.
      if (body.messages.some((m) => m.role === "tool")) {
        json(res, 200, completion(modelId, ++counter, { role: "assistant", content: "Recorded." }));
        return;
      }

      const { question, revision } = envelopeOf(body.messages);
      bump(served, question, 1);
      reviewedRevisions.set(question, [...(reviewedRevisions.get(question) ?? []), revision]);
      const verdict = rules.get(question);
      if (!verdict) {
        unmatchedRequests.push(question);
        json(res, 500, {
          error: { message: "no scripted privacy verdict for this request" },
        });
        return;
      }

      const gate = gates.get(question);
      if (gate) {
        bump(parked, question, 1);
        try {
          await gate.promise;
        } finally {
          bump(parked, question, -1);
        }
      }

      if (verdict.kind === "text") {
        json(
          res,
          200,
          completion(modelId, ++counter, { role: "assistant", content: verdict.text }),
        );
        return;
      }
      bump(submitted, question, 1);
      json(
        res,
        200,
        completion(
          modelId,
          ++counter,
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_${counter}`,
                type: "function",
                function: {
                  name: "submit_privacy_review",
                  arguments: JSON.stringify(verdict.review),
                },
              },
            ],
          },
          "tool_calls",
        ),
      );
    })().catch(() => {
      try {
        json(res, 500, { error: { message: "scripted privacy-reviewer server error" } });
      } catch {
        /* response already gone */
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("scripted privacy-reviewer failed to bind a port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    modelId,
    script: (question, verdict) => rules.set(question, verdict),
    hold: (question) => {
      let open: () => void = () => {};
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      gates.set(question, { promise, open });
    },
    release: (question) => {
      const gate = gates.get(question);
      gates.delete(question);
      gate?.open();
    },
    releaseAll: () => {
      const open = [...gates.values()];
      gates.clear();
      for (const gate of open) gate.open();
    },
    pending: (question) => parked.get(question) ?? 0,
    servedCalls: (question) => served.get(question) ?? 0,
    submissions: (question) => submitted.get(question) ?? 0,
    policyRevisions: (question) => reviewedRevisions.get(question) ?? [],
    unmatched: () => unmatchedRequests,
    closeAllConnections: () => server.closeAllConnections(),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function completion(
  model: string,
  seq: number,
  message: Record<string, unknown>,
  finishReason: "stop" | "tool_calls" = "stop",
): Record<string, unknown> {
  return {
    id: `scripted-review-${seq}`,
    object: "chat.completion",
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 128, completion_tokens: 24 },
  };
}

/**
 * A verdict that releases. `reconcileDecision` turns an `allow` carrying no
 * findings into `ask`, so every release-bound verdict states one finding whose
 * disposition is `allow`.
 */
const ALLOW: ScriptedVerdict = {
  kind: "submit",
  review: {
    decision: "allow",
    confidence: 0.97,
    findings: [
      {
        category: "business_detail",
        detailLevel: "summary",
        subject: "unknown",
        disposition: "allow",
        description: "Ordinary operational detail the workflow purpose covers.",
      },
    ],
    rationale: "Nothing here identifies a person or exceeds the stated purpose.",
  },
};

// ── suite ────────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  status: string;
  candidate_answer: string | null;
  candidate_digest: string | null;
  review_json: string | null;
  denial_reason: string | null;
  release_id: string | null;
}

interface ReviewRecord {
  fallbackCause: string | null;
  provider: string | null;
  model: string | null;
  confidence: number | null;
}

interface RoleAssignment {
  kind: string;
  available?: boolean;
  model?: string;
  reason?: string;
}

interface ModelsOverview {
  inference: { assignments: Record<string, RoleAssignment> };
}

interface GatewayConfig {
  inference?: { assignments?: Record<string, string | null> };
  [key: string]: unknown;
}

describe("REST Answer boundary — spawned replay gateway", () => {
  let harness: SyntheticE2EHarness;
  let reviewer: ScriptedReviewer;
  let answerToken: string;

  const readDb = <T>(fn: (db: Database.Database) => T): T => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  const taskByRequest = (clientRequestId: string): TaskRow | undefined =>
    readDb((db) =>
      db
        .prepare<
          [string],
          TaskRow
        >("SELECT id, status, candidate_answer, candidate_digest, review_json, denial_reason, release_id FROM answer_tasks WHERE client_request_id = ?")
        .get(clientRequestId),
    );

  const task = (taskId: string): TaskRow =>
    readDb((db) => {
      const row = db
        .prepare<
          [string],
          TaskRow
        >("SELECT id, status, candidate_answer, candidate_digest, review_json, denial_reason, release_id FROM answer_tasks WHERE id = ?")
        .get(taskId);
      if (!row) throw new Error(`no answer_tasks row for ${taskId}`);
      return row;
    });

  const reviewOf = (row: TaskRow): ReviewRecord => {
    if (!row.review_json) throw new Error(`task ${row.id} has no review_json`);
    return JSON.parse(row.review_json) as ReviewRecord;
  };

  const auditCount = (taskId: string, eventType: string): number =>
    readDb(
      (db) =>
        db
          .prepare<
            [string, string],
            { n: number }
          >("SELECT COUNT(*) AS n FROM answer_audit_events WHERE task_id = ? AND event_type = ?")
          .get(taskId, eventType)?.n ?? 0,
    );

  const egressEndpoints = (taskId: string): string[] =>
    readDb((db) =>
      db
        .prepare<[string], { endpoint: string }>(
          "SELECT endpoint FROM answer_egress_events WHERE task_id = ? ORDER BY created_at, id",
        )
        .all(taskId)
        .map((row) => row.endpoint),
    );

  const rowCount = (table: "answer_approvals" | "answer_releases", taskId: string): number =>
    readDb(
      (db) =>
        db
          .prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = ?`)
          .get(taskId)?.n ?? 0,
    );

  const transcript = (taskId: string): Array<{ role: string; content: string }> =>
    readDb((db) =>
      db
        .prepare<
          [string],
          { role: string; content: string }
        >("SELECT role, content FROM answer_messages WHERE task_id = ? ORDER BY id")
        .all(taskId),
    );

  const ask = (
    question: string,
    clientRequestId: string,
    extra: Record<string, unknown> = {},
    init: RequestInit = {},
  ): Promise<Response> =>
    fetch(`${harness.gatewayUrl}/answer`, {
      ...init,
      method: "POST",
      headers: { Authorization: `Bearer ${answerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ question, clientRequestId, ...extra }),
    });

  const collect = (taskId: string): Promise<Response> =>
    fetch(`${harness.gatewayUrl}/answer/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${answerToken}` },
    });

  const reviewerAssignment = async (): Promise<RoleAssignment> =>
    (await harness.gatewayJson<ModelsOverview>("/admin/models")).inference.assignments[
      "privacy-reviewer"
    ];

  /**
   * Wait until the registry says the reviewer is genuinely usable.
   *
   * `kind` alone proves nothing: `resolveHttpAssignment` answers `"http"` for
   * any declared backend key and reports failure separately as
   * `available: false` + `reason`, and `resolveRoleBackend` returns null on an
   * unavailable one — which is the same `not_configured` denial two tests here
   * assert. So a guard on `kind` would pass in exactly the silent state it
   * exists to catch. A boot probe can also be held `unreachable` when the event
   * loop was starved during it, and the periodic recovery is 30s away, so a
   * probe is forced between polls rather than waited out.
   */
  const waitForReviewerAvailable = async (): Promise<void> => {
    await vi.waitFor(
      async () => {
        let assignment = await reviewerAssignment();
        if (assignment.available !== true) {
          await harness.gatewayFetch("/admin/inference/backends/reviewer/probe", {
            method: "POST",
          });
          assignment = await reviewerAssignment();
        }
        expect({
          kind: assignment.kind,
          available: assignment.available,
          model: assignment.model,
          reason: assignment.reason,
        }).toEqual({
          kind: "http",
          available: true,
          model: reviewer.modelId,
          reason: undefined,
        });
      },
      { timeout: 60_000, interval: 500 },
    );
  };

  beforeAll(async () => {
    reviewer = await startScriptedReviewer();
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "default",
      agentBackend: "replay",
      extraInference: {
        backends: { reviewer: { type: "http", url: reviewer.url } },
        assignments: { "privacy-reviewer": `reviewer/${reviewer.modelId}` },
      },
    });
    await harness.start();

    // A dedicated `answer`-scoped token: `callerOf` derives the owner id from
    // the token, so the per-owner turn budget the poll test measures is this
    // caller's alone and the harness admin token cannot disturb it.
    const paired = await harness.gatewayJson<{ token: string; scopes: string[] }>(
      "/admin/devices",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Answer boundary E2E",
          kind: "cli",
          scopes: ["answer"],
        }),
      },
    );
    expect(paired.scopes).toEqual(["answer"]);
    answerToken = paired.token;

    await waitForReviewerAvailable();
  }, 240_000);

  afterAll(async () => {
    await harness.destroy();
    // Nothing else on this gateway may have consulted the reviewer. An entry
    // here would mean some other review (a watch-existence check, a
    // firing-bound answer) was served a 500 and its outcome silently folded
    // into a counter one of these tests reads.
    expect(reviewer.unmatched()).toEqual([]);
    // Release every gate first: `server.close()` waits for open connections,
    // so a test that failed with a review still parked would hang teardown.
    reviewer.releaseAll();
    reviewer.closeAllConnections();
    await reviewer.close();
  }, 30_000);

  test('with approval:"never", every verdict that is neither allow nor deny becomes one denial that keeps no candidate, mints no approval and writes no release', async () => {
    // Three different mechanisms — the reviewer's own decision, the
    // confidence gate, and a submission that never arrived — all of which
    // must land on the same `holdOrDenyWithoutApproval(..., "never")`.
    reviewer.script(SUPPLIER.question, {
      kind: "submit",
      review: {
        decision: "ask",
        confidence: 0.96,
        findings: [
          {
            category: "private_identifier",
            detailLevel: "exact",
            subject: "other_person",
            disposition: "approval",
            description: "Names a counterparty the workflow purpose does not cover.",
          },
        ],
        rationale: "The user should decide whether this counterparty may be named.",
      },
    });
    reviewer.script(DELIVERY.question, {
      kind: "submit",
      review: {
        decision: "allow",
        confidence: 0.4,
        findings: [
          {
            category: "business_detail",
            detailLevel: "summary",
            subject: "unknown",
            disposition: "allow",
            description: "Delivery scheduling detail.",
          },
        ],
        rationale: "Reading of the policy is uncertain here.",
      },
    });
    reviewer.script(TENANCY.question, {
      kind: "text",
      text: "This candidate looks acceptable to me.",
    });

    const arms = [
      {
        question: SUPPLIER.question,
        clientRequestId: "never_ask_e2e",
        fallbackCause: "policy_requires_review",
      },
      {
        question: DELIVERY.question,
        clientRequestId: "never_lowconf_e2e",
        fallbackCause: "low_confidence",
      },
      {
        question: TENANCY.question,
        clientRequestId: "never_nosubmit_e2e",
        fallbackCause: "invalid_output",
      },
    ] as const;

    for (const arm of arms) {
      const before = reviewer.servedCalls(arm.question);
      // No `approval` field: the route applies its own `"never"` default.
      const response = await ask(arm.question, arm.clientRequestId);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({
        status: "denied",
        reason: "approval_not_available",
      });

      // The reviewer really ran. Without this a silently-unresolved reviewer
      // would be indistinguishable from the fail-closed arm under test.
      expect(reviewer.servedCalls(arm.question)).toBe(before + 1);

      const row = taskByRequest(arm.clientRequestId);
      expect(row).toBeDefined();
      expect(row!.status).toBe("denied");
      expect(row!.denial_reason).toBe("approval_not_available");
      // A candidate nobody may ever approve is not left sitting in the store.
      expect(row!.candidate_answer).toBeNull();
      expect(row!.candidate_digest).toBeNull();
      // Which mechanism this arm actually took — what proves the three arms
      // are three routes rather than one standing in for the others.
      expect(reviewOf(row!).fallbackCause).toBe(arm.fallbackCause);
      expect(rowCount("answer_approvals", row!.id)).toBe(0);
      expect(rowCount("answer_releases", row!.id)).toBe(0);
      // The denial itself crossed the boundary, so it is recorded as one.
      expect(egressEndpoints(row!.id)).toEqual(["/answer"]);
      // The denied candidate never entered the transcript a later turn on
      // this conversation would replay back to the same external agent.
      const assistantTurns = transcript(row!.id).filter((m) => m.role === "assistant");
      expect(assistantTurns.map((m) => m.content)).toEqual([DENIED_TRANSCRIPT_MARKER]);
    }
  }, 120_000);

  test("a repeat of an in-flight ask is a poll: it attaches to the running task at the owner's turn limit, opens no second turn, and later collects the same bytes", async () => {
    reviewer.script(SUPPLIER.question, ALLOW);
    reviewer.script(DELIVERY.question, ALLOW);
    reviewer.hold(SUPPLIER.question);
    reviewer.hold(DELIVERY.question);
    const submissionsBefore = {
      supplier: reviewer.submissions(SUPPLIER.question),
      delivery: reviewer.submissions(DELIVERY.question),
    };

    // These two asks have to be the owner's whole budget, or the capacity
    // control below proves nothing. Reading the real default rather than
    // restating it means a change to it reddens here, naming the mismatch,
    // instead of surfacing as an unexplained 200 where a 503 was expected.
    const held = [SUPPLIER.question, DELIVERY.question];
    expect(held).toHaveLength(DEFAULT_MAX_CONCURRENT_ANSWERS_PER_OWNER);

    const a = ask(SUPPLIER.question, "poll_e2e_a");
    const b = ask(DELIVERY.question, "poll_e2e_b");

    // Both turns are parked on the reviewer gate, which is strictly after
    // `acquireCapacity`, so this owner now holds every turn it is allowed.
    await vi.waitFor(() => {
      for (const question of held) expect(reviewer.pending(question)).toBe(1);
    }, COUNTER_WAIT);

    let taskA: TaskRow | undefined;
    await vi.waitFor(() => {
      taskA = taskByRequest("poll_e2e_a");
      expect(taskA?.status).toBe("running");
    }, DB_WAIT);

    // The control. Without it the poll below proves nothing: a 409 would be
    // just as consistent with an owner that was never at its limit.
    // `gatewayJson` is deliberately not used for these — it waits out a 503.
    const full = await ask(TENANCY.question, `poll_e2e_new_${randomUUID()}`);
    expect(full.status).toBe(503);
    expect(await full.json()).toMatchObject({ code: "ANSWER_CAPACITY" });

    // The invariant: byte-identical body, same request id, same instant —
    // admitted as a poll rather than refused as new work.
    const poll = await ask(SUPPLIER.question, "poll_e2e_a");
    expect(poll.status).toBe(409);
    expect(await poll.json()).toMatchObject({
      code: "ANSWER_IN_PROGRESS",
      detail: { taskId: taskA!.id },
    });

    reviewer.releaseAll();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    const firstBody = await ra.text();
    await rb.text();
    expect(JSON.parse(firstBody)).toMatchObject({
      status: "released",
      taskId: taskA!.id,
      answer: SUPPLIER.draft,
    });

    // The poll the contract tells a client to make after a timeout. The route
    // answers through `exactJsonResponse`, so canonical bytes are the contract.
    const again = await ask(SUPPLIER.question, "poll_e2e_a");
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(firstBody);

    // Three POSTs, one task.
    expect(
      readDb(
        (db) =>
          db
            .prepare<
              [string],
              { n: number }
            >("SELECT COUNT(*) AS n FROM answer_tasks WHERE client_request_id = ?")
            .get("poll_e2e_a")?.n,
      ),
    ).toBe(1);
    // One agent turn ran, so neither the model spend nor the workflow
    // disclosure was doubled, and `beginAnswerTask` recorded no second
    // external request for the duplicate.
    expect(auditCount(taskA!.id, "agent_trace")).toBe(1);
    expect(auditCount(taskA!.id, "candidate_generated")).toBe(1);
    expect(auditCount(taskA!.id, "external_request")).toBe(1);
    // The 409 threw before the release seam and recorded nothing; the third
    // POST re-collected the same canonical response, which `recordAnswerEgress`
    // dedupes on (task, digest). "Shared" is a first-disclosure count, not a
    // retrieval count.
    expect(egressEndpoints(taskA!.id)).toEqual(["/answer"]);
    expect(reviewer.submissions(SUPPLIER.question)).toBe(submissionsBefore.supplier + 1);
    expect(reviewer.submissions(DELIVERY.question)).toBe(submissionsBefore.delivery + 1);
  }, 120_000);

  test("a turn whose caller disconnected still commits, records no egress, and hands its bytes over only when something live collects them", async () => {
    reviewer.script(TENANCY.question, ALLOW);
    reviewer.hold(TENANCY.question);
    const submissionsBefore = reviewer.submissions(TENANCY.question);
    // Only what this test appends to the gateway's journal counts, so a later
    // reordering cannot let an earlier test's line stand in for this one's.
    const logBefore = readFileSync(harness.getGatewayLogPath(), "utf8").length;

    const controller = new AbortController();
    const inflight = ask(TENANCY.question, "disconnect_e2e", {}, { signal: controller.signal });

    // Abort as early as the task is durably `running`, well before the review
    // is parked: nothing on this path consumes the request signal except the
    // pre-egress check, so the whole of generation plus the review round trip
    // plus a writer commit is slack between the abort and the decision it has
    // to be visible to.
    let taskId = "";
    await vi.waitFor(() => {
      const row = taskByRequest("disconnect_e2e");
      expect(row?.status).toBe("running");
      taskId = row!.id;
    }, DB_WAIT);

    controller.abort();
    const failure = await inflight.then(
      () => null,
      (err: unknown) => err,
    );
    // Any rejection would satisfy `rejects.toThrow()` — a TLS error or a
    // gateway crash would then masquerade as a clean client abort and the
    // rest of this test would assert nothing about disconnect.
    expect(abortNameOf(failure)).toBe("AbortError");

    // Two completed round trips after the abort: each settles only once the
    // gateway's event loop has processed callbacks queued before it, which is
    // where `@hono/node-server` aborts `c.req.raw.signal` on socket close.
    expect((await harness.gatewayFetch("/health")).status).toBe(200);
    expect((await harness.gatewayFetch("/health")).status).toBe(200);

    await vi.waitFor(() => expect(reviewer.pending(TENANCY.question)).toBe(1), COUNTER_WAIT);
    reviewer.release(TENANCY.question);

    await vi.waitFor(() => expect(task(taskId).status).toBe("released"), DB_WAIT);
    // The release seam is the only thing on this path that reads the request
    // signal, and it refused — so the empty ledger below is the abort landing
    // rather than an egress that simply failed to happen for some other reason.
    await vi.waitFor(() => {
      expect(readFileSync(harness.getGatewayLogPath(), "utf8").slice(logBefore)).toContain(
        "Answer task completed after the client disconnected.",
      );
    }, DB_WAIT);
    // Work kept, disclosure not claimed. An egress row here would assert that
    // bytes reached an integration that had already hung up.
    expect(egressEndpoints(taskId)).toEqual([]);
    expect(rowCount("answer_releases", taskId)).toBe(1);
    expect(task(taskId).release_id).not.toBeNull();

    const collected = await collect(taskId);
    expect(collected.status).toBe(200);
    const collectedBody = await collected.text();
    // The caller lost nothing by hanging up: the bytes it never received are
    // exactly the draft its turn generated.
    expect(JSON.parse(collectedBody)).toMatchObject({
      status: "released",
      taskId,
      answer: TENANCY.draft,
    });
    // The hand-over is attributed to the collection, not to the handshake
    // that never delivered.
    expect(egressEndpoints(taskId)).toEqual(["/answer/tasks/:id"]);

    const second = await collect(taskId);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(collectedBody);
    // Re-collecting the same canonical response is retrieval, not a second
    // disclosure.
    expect(egressEndpoints(taskId)).toEqual(["/answer/tasks/:id"]);
    expect(reviewer.submissions(TENANCY.question)).toBe(submissionsBefore + 1);
  }, 120_000);

  // Last: it mutates the live assignment and restores it.
  test("an install with no privacy reviewer assigned denies every unattended answer without consulting a model, and releases again the moment one is assigned", async () => {
    const setReviewerAssignment = async (value: string | null): Promise<void> => {
      const { config } = await harness.gatewayJson<{ config: GatewayConfig }>("/admin/config");
      // An explicit null resolves to `{kind: "disabled"}`. A merge-PATCH
      // cannot express it — RFC 7386 reads null as delete — so this is a PUT.
      config.inference = {
        ...config.inference,
        assignments: { ...config.inference?.assignments, "privacy-reviewer": value },
      };
      await harness.gatewayJson("/admin/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
    };

    await setReviewerAssignment(null);
    // The config listener chain is fire-and-forget, so the PUT's 200 does not
    // imply the registry reloaded. `/admin/models` is the registry's own view.
    await vi.waitFor(async () => expect((await reviewerAssignment()).kind).toBe("disabled"), {
      timeout: 30_000,
      interval: 200,
    });

    const servedBefore = reviewer.servedCalls(MEMBER.question);
    const denied = await ask(MEMBER.question, "unconfigured_e2e");
    // A clean, final, machine-readable refusal — not a 5xx, not a hold.
    expect(denied.status).toBe(200);
    const deniedBody = await denied.text();
    expect(JSON.parse(deniedBody)).toMatchObject({
      status: "denied",
      reason: "approval_not_available",
    });
    expect(deniedBody).not.toContain(MEMBER.draft);
    // No model was consulted at all: `resolveBackend()` returned null and the
    // reviewer short-circuited. This is what separates the unconfigured
    // install from a reviewer that answered badly.
    expect(reviewer.servedCalls(MEMBER.question)).toBe(servedBefore);

    const deniedRow = taskByRequest("unconfigured_e2e");
    expect(deniedRow?.status).toBe("denied");
    // The durable record says *why* the gate closed — what an operator
    // debugging "every answer is denied" reads.
    expect(reviewOf(deniedRow!)).toMatchObject({
      fallbackCause: "not_configured",
      provider: null,
      model: null,
      confidence: null,
    });
    expect(deniedRow!.candidate_answer).toBeNull();
    expect(rowCount("answer_approvals", deniedRow!.id)).toBe(0);
    expect(rowCount("answer_releases", deniedRow!.id)).toBe(0);
    // The honest cost of a misconfigured install: the candidate was generated
    // and then discarded. The spend happens; the bytes stay inside.
    expect(auditCount(deniedRow!.id, "agent_trace")).toBe(1);
    expect(auditCount(deniedRow!.id, "candidate_generated")).toBe(1);

    await setReviewerAssignment(`reviewer/${reviewer.modelId}`);
    await waitForReviewerAvailable();
    reviewer.script(MEMBER.question, ALLOW);
    const ok = await ask(MEMBER.question, "reconfigured_e2e");
    expect(ok.status).toBe(200);
    const okBody = await ok.text();
    // The denial was the gate being closed, not the gateway being broken.
    expect(JSON.parse(okBody)).toMatchObject({ status: "released" });
    expect(JSON.parse(okBody)).toMatchObject({ answer: MEMBER.draft });
    expect(reviewer.servedCalls(MEMBER.question)).toBe(servedBefore + 1);
  }, 120_000);

  test("an integration answers only under its access level's Answer rule, owns its answers under that scope, and is refused on no level or one that cannot answer", async () => {
    const portal = await loginPortal({
      gatewayUrl: harness.gatewayUrl,
      apiKey: harness.apiKey,
      gatewayLogPath: harness.getGatewayLogPath(),
    });
    const family = await portalJson<{ familyId: string; revision: string }>(
      harness.gatewayUrl,
      portal,
      "/admin/privacy/policies",
      { name: "Fictional voice assistant policy", templateId: "open" },
    );
    const overview = await portalJson<{
      sources: { id: string }[];
      policyFamilies: { id: string; revision: string }[];
    }>(harness.gatewayUrl, portal, "/admin/access");
    const defaultRevision = overview.policyFamilies.find(
      (policy) => policy.id === DEFAULT_PRIVACY_POLICY_FAMILY_ID,
    )!.revision;
    expect(family.revision).not.toBe(defaultRevision);
    const answerRule = (sources: { mode: string; sourceIds: string[] }) => ({
      capability: "answer",
      sources,
      release: { mode: "reviewed", policyFamilyId: family.familyId },
    });
    const { level } = await portalJson<{ level: { id: string; revision: number } }>(
      harness.gatewayUrl,
      portal,
      "/admin/access/levels",
      {
        name: "Fictional voice answers",
        rules: [answerRule({ mode: "all", sourceIds: [] })],
      },
    );

    // Its own integration, so putting it on a level disturbs no other test's owner.
    const paired = await harness.gatewayJson<{ token: string; device: { id: string } }>(
      "/admin/devices",
      {
        method: "POST",
        body: JSON.stringify({ name: "Access level E2E", kind: "integration", scopes: ["answer"] }),
      },
    );
    const levelPath = `/admin/access/devices/${paired.device.id}/level`;
    const putLevel = (levelId: string | null) =>
      portalRequest(harness.gatewayUrl, portal, "PUT", levelPath, { levelId });
    const askAs = (clientRequestId: string) =>
      fetch(`${harness.gatewayUrl}/answer`, {
        method: "POST",
        headers: { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ question: DELIVERY.question, clientRequestId }),
      });
    const pollAs = (taskId: string) =>
      fetch(`${harness.gatewayUrl}/answer/tasks/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${paired.token}` },
      });

    // An admin bearer token cannot change what a device may read.
    const bearer = await fetch(`${harness.gatewayUrl}${levelPath}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${harness.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ levelId: level.id }),
    });
    expect(bearer.status).toBe(403);

    reviewer.script(DELIVERY.question, ALLOW);
    const reviewsBefore = reviewer.policyRevisions(DELIVERY.question).length;

    // A new integration on no level is answered nothing until one is chosen.
    const unassigned = await askAs("device_level_e2e_unassigned");
    expect(unassigned.status).toBe(403);
    expect(((await unassigned.json()) as { code: string }).code).toBe("ACCESS_LEVEL_REQUIRED");

    expect((await putLevel(level.id)).status).toBe(200);
    const onLevel = await askAs("device_level_e2e");
    expect(onLevel.status).toBe(200);
    const onLevelBody = (await onLevel.json()) as { status: string; taskId: string };
    expect(onLevelBody.status).toBe("released");
    expect(reviewer.policyRevisions(DELIVERY.question).slice(reviewsBefore)).toEqual([
      family.revision,
    ]);
    expect((await pollAs(onLevelBody.taskId)).status).toBe(200);

    // A portal session opened with the device's token asks under its level too.
    const session = await loginPortal({
      gatewayUrl: harness.gatewayUrl,
      apiKey: paired.token,
      gatewayLogPath: harness.getGatewayLogPath(),
    });
    const viaSession = await portalRequest(harness.gatewayUrl, session, "POST", "/answer", {
      question: DELIVERY.question,
      clientRequestId: "device_level_e2e_session",
    });
    expect(viaSession.status).toBe(200);
    expect(reviewer.policyRevisions(DELIVERY.question).slice(reviewsBefore)).toEqual([
      family.revision,
      family.revision,
    ]);

    // Narrowing the level's sources is a new scope: the answer made under the
    // wider one is no longer this device's to collect.
    const narrowed = await portalRequest(
      harness.gatewayUrl,
      portal,
      "PATCH",
      `/admin/access/levels/${level.id}`,
      {
        expectedRevision: level.revision,
        rules: [answerRule({ mode: "allowlist", sourceIds: [overview.sources[0]!.id] })],
      },
    );
    expect(narrowed.status).toBe(200);
    expect((await pollAs(onLevelBody.taskId)).status).toBe(404);

    // A level a device uses is not deleted out from under it.
    const deleted = await portalRequest(
      harness.gatewayUrl,
      portal,
      "DELETE",
      `/admin/access/levels/${level.id}`,
    );
    expect(deleted).toEqual({ status: 409, body: { error: "level-in-use" } });

    // Off every level, an integration is answered nothing — never the default.
    expect((await putLevel(null)).status).toBe(200);
    const offLevel = await askAs("device_level_e2e");
    expect(offLevel.status).toBe(403);
    expect(((await offLevel.json()) as { code: string }).code).toBe("ACCESS_LEVEL_REQUIRED");
    expect(reviewer.policyRevisions(DELIVERY.question).slice(reviewsBefore)).toEqual([
      family.revision,
      family.revision,
    ]);

    // A level whose privacy policy is gone can no longer answer: the device is
    // refused rather than answered under a policy the operator did not choose.
    expect((await putLevel(level.id)).status).toBe(200);
    const db = new Database(harness.getDbPath());
    try {
      db.prepare("UPDATE privacy_policy_families SET archived_at = ? WHERE id = ?").run(
        Date.now(),
        family.familyId,
      );
    } finally {
      db.close();
    }
    const refused = await askAs("device_level_e2e_archived");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("ACCESS_LEVEL_UNAVAILABLE");
    expect(reviewer.policyRevisions(DELIVERY.question).slice(reviewsBefore)).toHaveLength(2);
  }, 120_000);
});

/** The abort name a client-side `AbortController` on `fetch` surfaces. */
function abortNameOf(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  if (err.name === "AbortError") return "AbortError";
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error ? cause.name : err.name;
}
