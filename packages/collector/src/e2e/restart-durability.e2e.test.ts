// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a gateway owes the operator across a process death.
 *
 * `omnesis update` restarts the gateway by design, and a crash, an OOM kill or
 * a `systemctl restart` does the same without warning. Four subsystems make a
 * promise across that boundary, and each one keeps it in a different place:
 *
 * - The durable push queue keeps its rows. A delivery still pending is still
 *   claimable with the same content; a delivery leased to a phone that has not
 *   confirmed is neither lost nor handed to anyone a second time; and the
 *   content-free wake ladder resumes at the attempt it had reached rather than
 *   starting over — a ladder that reset on every boot would wake a phone
 *   forever and never spend its budget.
 * - The vector index survives the boot that re-derives its embedder. The
 *   indexer worker re-reads the embedder's identity from a fresh probe on every
 *   start and wipes the whole index when it does not match the stamp the
 *   previous run left behind. This file's embedder is a harness-owned server
 *   the restart does not touch, so the two identities are equal by
 *   construction, and the test is the narrower canary it can honestly be: boot
 *   must not wipe unconditionally. A spurious wipe re-embeds the corpus on
 *   EVERY restart — hours of work and a vector-search outage per boot on a real
 *   install, reported by nothing except "indexing is always running".
 * - The privacy Answer boundary keeps its idempotency. A task caught mid-review
 *   is flipped to `failed` with an audit event saying why, its conversation is
 *   freed, and the external agent's next repeat of the SAME clientRequestId
 *   restarts that task in place. Miss the first half and the conversation is
 *   `conversation_busy` forever; miss the second and the request id is
 *   permanently poisoned with no way forward but a new one.
 * - The agent's live event stream tells its clients the truth. `nextSeq` resets
 *   to 1 and the replay ring is empty, so a client reconnecting with a
 *   pre-restart `Last-Event-ID` is answered with one `agent.resync` control
 *   frame — no `id:` line, nothing resumable — and reloads the persisted
 *   transcript instead of sitting on an optimistic bubble against a turn no
 *   server remembers. That branch of `replayFrom` is only reachable after a
 *   real process boundary, so no in-process test can enter it.
 *
 * Time is never waited out. Where a deadline decides the outcome — a content
 * lease that would otherwise lapse during the boot, a wake backoff ten minutes
 * away — it is rewritten inside `restartGateway`'s `whileStopped` callback,
 * with the gateway fully down and no second writer to race
 * (`apple-mode-transition.e2e.test.ts` stages a legacy database the same way).
 * Every other barrier is a persisted row, a counter, or a framed SSE id.
 *
 * The tests are independent: each asserts the preconditions it needs rather
 * than inheriting them from the test above it, so a reorder cannot quietly
 * turn one of them into a sampling test.
 */

import "./synth-env.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { waitForCondition } from "./multi-collector-harness.js";
import type { AddressInfo, Socket } from "node:net";

/** Every `it()` here restarts a gateway whose own boot budget is 90s. */
const TEST_TIMEOUT_MS = 180_000;
const CORPUS_SIZE = 60;

/** The exact content `PushTransport.sendTest` renders (watch/push-transport.ts). */
const TEST_PUSH_TITLE = "Omnesis";
const TEST_PUSH_BODY = "Test notification from your gateway.";
const TEST_PUSH_COLLAPSE_ID = "push-test";

/** Routes to the `privacy-delivery-window` cassette in the `default` universe. */
const ANSWER_QUESTION = "When is the Halden Press order due to arrive?";
const ANSWER_REQUEST_ID = "restart-durability-answer-1";
/** Routes to `privacy-member-reference` — three events, no placeholders to resolve. */
const AGENT_TRIGGER = "What is the Northstar Club member reference?";

// ── the gated privacy-reviewer backend ──────────────────────────────────────

/**
 * An OpenAI-compatible chat server that can be told to accept a request and
 * never answer it, so a privacy review is provably still in flight at the
 * moment the gateway dies. Modelled on `brain-bench/openai-server.ts`: only
 * non-streamed completions are served, and a `stream: true` request is refused
 * with a request-shape 400 so `HttpChatBackend`'s stream → stream-without-
 * options → non-streamed ladder lands in the one shape this server speaks.
 */
interface GatedReviewer {
  url: string;
  readonly modelId: string;
  /** When true, a chat completion is recorded and the socket is left open. */
  hold: boolean;
  /** Chat completions received while holding. */
  calls: number;
  close(): Promise<void>;
}

async function startGatedReviewer(): Promise<GatedReviewer> {
  const sockets = new Set<Socket>();
  const handle: GatedReviewer = {
    url: "",
    modelId: "gated-reviewer-v1",
    hold: false,
    calls: 0,
    close: async () => {},
  };

  const answerJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/v1/models")) {
      answerJson(res, 200, {
        object: "list",
        data: [{ id: handle.modelId, object: "model", owned_by: "omnesis-e2e" }],
      });
      return;
    }
    if (req.method === "POST" && url.startsWith("/v1/chat/completions")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (handle.hold) {
          // Deliberately no response and no socket timeout: the request stays
          // in flight until the gateway process dies or `close()` destroys it.
          handle.calls += 1;
          return;
        }
        let body: { stream?: unknown } | null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: unknown };
        } catch {
          body = null;
        }
        if (!body) {
          answerJson(res, 400, { error: { message: "malformed request body" } });
          return;
        }
        if (body.stream === true) {
          answerJson(res, 400, {
            error: { message: "stream is not supported by this scripted server" },
          });
          return;
        }
        answerJson(res, 200, {
          id: "gated-reviewer-1",
          object: "chat.completion",
          model: handle.modelId,
          choices: [
            { index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      });
      return;
    }
    answerJson(res, 404, { error: { message: `no route for ${req.method} ${url}` } });
  });

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  handle.url = `http://127.0.0.1:${address.port}`;
  handle.close = () =>
    new Promise<void>((resolve, reject) => {
      // A held request owns its socket; `server.close()` would wait for it.
      for (const socket of sockets) socket.destroy();
      server.close((err) => (err ? reject(err) : resolve()));
    });
  return handle;
}

// ── SSE framing ─────────────────────────────────────────────────────────────

interface SseBlock {
  /** The raw block text, without its terminating blank line. */
  raw: string;
  id?: string;
  data?: string;
}

/**
 * Reads `/agent/events` a framed block at a time. The `id:` line is kept as
 * raw text: a control frame's *absence* of one is the thing under test, and a
 * parsed view would not show it.
 */
class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly queued: SseBlock[] = [];
  private readonly seen: string[] = [];
  private buffer = "";
  private inflight: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  /** The next block, or a failure naming every block seen so far. */
  async next(timeoutMs: number, label: string): Promise<SseBlock> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const queued = this.queued.shift();
      if (queued) return queued;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for ${label}. Blocks seen: ${this.seen.join(" | ") || "(none)"}`,
        );
      }
      this.inflight ??= this.reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        this.inflight,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), remaining);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (result === null) continue; // keep the in-flight read for the next pass
      this.inflight = null;
      if (result.done || !result.value) {
        throw new Error(
          `The SSE stream ended before ${label}. Blocks seen: ${this.seen.join(" | ") || "(none)"}`,
        );
      }
      this.buffer += this.decoder.decode(result.value, { stream: true });
      let end: number;
      while ((end = this.buffer.indexOf("\n\n")) !== -1) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        const lines = raw.split("\n");
        const idLine = lines.find((line) => line.startsWith("id:"));
        const dataLine = lines.find((line) => line.startsWith("data:"));
        const block: SseBlock = {
          raw,
          ...(idLine ? { id: idLine.slice("id:".length).trim() } : {}),
          ...(dataLine ? { data: dataLine.slice("data:".length).trim() } : {}),
        };
        this.seen.push(raw.replace(/\n/g, "\\n").slice(0, 160));
        this.queued.push(block);
      }
    }
  }

  /** The next block carrying a `data:` line; heartbeat comments are skipped. */
  async nextData(timeoutMs: number, label: string): Promise<SseBlock> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const block = await this.next(Math.max(1, deadline - Date.now()), label);
      if (block.data !== undefined) return block;
    }
  }

  async close(): Promise<void> {
    try {
      await this.reader.cancel();
    } catch {
      /* the stream may already be gone */
    }
  }
}

// ── the suite ───────────────────────────────────────────────────────────────

interface IndexStats {
  state: string;
  totalIndexed?: number;
}

interface IndexedDocumentRow {
  document_id: string;
  content_hash: string;
  chunk_count: number;
  indexed_at: string;
}

interface DeliveryRow {
  id: string;
  notification_id: string;
  state: string;
  delivered_at: number | null;
  wake_state: string;
  wake_attempt_count: number;
}

interface ClaimedDelivery {
  id: string;
  title: string;
  body: string;
  collapseId: string;
  remaining: number;
}

interface AnswerTaskRow {
  id: string;
  status: string;
  conversation_id: string;
  resolved_at: number | null;
  candidate_answer: string | null;
}

interface FakePhone {
  deviceId: string;
  token: string;
  authToken: string;
}

describe("gateway restart durability", () => {
  let harness: SyntheticE2EHarness;
  let gate: GatedReviewer;
  let phoneA: FakePhone;
  let phoneB: FakePhone;
  /** APNs tokens the fake answers 503 (non-terminal) for. */
  const failingApnsTokens = new Set<string>();
  /** In-flight `/answer` requests, settled during teardown. */
  const pendingAnswers: Promise<void>[] = [];

  const corpus = Array.from({ length: CORPUS_SIZE }, (_value, index) => ({
    externalId: `restart-durability-doc-${index}`,
    title: `Studio Northstar service note ${index}`,
    content:
      `Service note ${index} for Studio Northstar, filed by Maya Reeves at 42 Example Street. ` +
      `Jamie Lopez logged bay ${index} as ready and left the follow-up with dispatch. ` +
      `Reference SN-${1000 + index}-${index % 7}; reply to notes${index}@example.com by the end of week ${index % 52}.`,
  }));

  function readDb<T>(read: (db: Database.Database) => T): T {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  }

  function readIndexDb<T>(read: (db: Database.Database) => T): T {
    const db = new Database(join(harness.getConfigDir(), "index.db"), { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  }

  function deliveryFor(deviceId: string): DeliveryRow | undefined {
    return readDb((db) =>
      db
        .prepare<[string], DeliveryRow>(
          `SELECT id, notification_id, state, delivered_at, wake_state, wake_attempt_count
             FROM notification_deliveries WHERE device_id = ?`,
        )
        .get(deviceId),
    );
  }

  function deliveryCountFor(deviceId: string): number {
    return readDb(
      (db) =>
        db
          .prepare<
            [string],
            { count: number }
          >("SELECT COUNT(*) AS count FROM notification_deliveries WHERE device_id = ?")
          .get(deviceId)!.count,
    );
  }

  function phoneRequest(path: string, phone: FakePhone, body: unknown): Promise<Response> {
    return fetch(`${harness.gatewayUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${phone.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async function indexStats(): Promise<IndexStats> {
    return harness.gatewayJson<IndexStats>("/index/stats");
  }

  async function waitForIndexSettled(total: number, label: string): Promise<void> {
    await waitForCondition(
      async () => {
        const stats = await indexStats();
        return stats.state === "running" && stats.totalIndexed === total;
      },
      120_000,
      label,
    );
  }

  /**
   * Force one synchronous probe of the gated backend through the registry, so
   * `resolveHttpAssignment` reports it `available` before a review needs it.
   * The boot probe is fired and never awaited, and an unprobed backend sends
   * `PrivacyReviewer` down its fail-open `not_configured` path instead of
   * calling the model at all.
   */
  async function probeGatedReviewer(): Promise<void> {
    const probe = await harness.gatewayJson<{ ok: boolean; status: string }>(
      "/admin/inference/backends/reviewgate/probe",
      { method: "POST" },
    );
    expect(
      probe,
      "the gated privacy-reviewer backend must probe OK, or the reviewer fails open to not_configured and never calls the model",
    ).toMatchObject({ ok: true, status: "ok" });
  }

  beforeAll(async () => {
    gate = await startGatedReviewer();
    harness = new SyntheticE2EHarness({
      gatewayMode: "experimental",
      // The only e2e universe carrying `agent-demos/`, which the replay agent
      // and the Answer boundary both route through.
      universe: "default",
      agentBackend: "replay",
      embedderBackend: "fake",
      apnsBackend: "fake",
      fakeApnsOptions: {
        // 503/ServiceUnavailable is not an unregistered-token reason, so the
        // broadcaster settles it as a retry rather than a terminal failure.
        respond: (push) =>
          failingApnsTokens.has(push.deviceToken)
            ? { statusCode: 503, reason: "ServiceUnavailable" }
            : { statusCode: 200 },
      },
      extraInference: {
        backends: { reviewgate: { type: "http", url: gate.url } },
        assignments: { "privacy-reviewer": `reviewgate/${gate.modelId}` },
      },
      extraGatewayConfig: {
        gateway: {
          pushWakeRetry: {
            // One failure parks a row for ten minutes, so a pre-restart
            // snapshot cannot move on its own however loaded the box is.
            initialBackoffMs: 600_000,
            maxBackoffMs: 600_000,
            maxAttempts: 10,
            leaseMs: 60_000,
            batchSize: 50,
            // Prompt while work is due, quiet once it is not: the sweep is a
            // writer-thread transaction and this file runs beside others.
            intervalMs: 500,
            idleIntervalMs: 30_000,
          },
        },
      },
    });
    await harness.start();

    await harness.pushDocuments(corpus);
    await waitForIndexSettled(
      CORPUS_SIZE,
      "the seeded corpus to finish indexing on the first boot",
    );

    phoneA = await harness.registerFakeIosDevice("Phone A");
    phoneB = await harness.registerFakeIosDevice("Phone B");
  }, 420_000);

  afterAll(async () => {
    await harness?.destroy();
    // The gateway is gone, so every held `/answer` has already rejected.
    await Promise.allSettled(pendingAnswers);
    await gate?.close();
  }, 60_000);

  test(
    "a process death loses no queued notification, re-hands no live lease, and resumes the wake ladder where it stopped",
    async () => {
      failingApnsTokens.add(phoneB.token);

      const sentToA = await harness.gatewayJson<{
        result: { attempted: number; delivered: number };
      }>(`/admin/push/test?deviceId=${encodeURIComponent(phoneA.deviceId)}`, { method: "POST" });
      const sentToB = await harness.gatewayJson<{
        result: { attempted: number; delivered: number };
      }>(`/admin/push/test?deviceId=${encodeURIComponent(phoneB.deviceId)}`, { method: "POST" });
      // `publish` awaits the wake dispatch inline, so both ladders have already
      // swung once by the time these return — B's into a 503.
      expect(sentToA.result).toMatchObject({ attempted: 1, delivered: 1 });
      expect(
        sentToB.result,
        "B's wake must have been attempted and refused, or there is no parked ladder to resume",
      ).toMatchObject({ attempted: 1, delivered: 0 });

      const claimRes = await phoneRequest("/notifications/claim", phoneA, {});
      expect(claimRes.status).toBe(200);
      const claimedByA = (await claimRes.json()) as ClaimedDelivery;
      const leaseTokenA = claimedByA.id;

      const beforeA = deliveryFor(phoneA.deviceId)!;
      const beforeB = deliveryFor(phoneB.deviceId)!;
      expect(beforeA).toMatchObject({ state: "leased", delivered_at: null });
      expect(beforeB).toMatchObject({
        state: "pending",
        wake_state: "pending",
        wake_attempt_count: 1,
      });

      await harness.restartGateway(() => {
        const db = new Database(harness.getDbPath());
        try {
          db.transaction(() => {
            // The lease was live at the moment of death: hold it well past the
            // boot so the assertion measures survival, never boot speed.
            db.prepare(
              "UPDATE notification_deliveries SET leased_until = ? WHERE device_id = ? AND state = 'leased'",
            ).run(Date.now() + 600_000, phoneA.deviceId);
            // Make B's parked backoff due without waiting ten minutes out.
            db.prepare(
              "UPDATE notification_deliveries SET wake_next_attempt_at = 0 WHERE device_id = ? AND wake_state = 'pending'",
            ).run(phoneB.deviceId);
          }).immediate();
        } finally {
          db.close();
        }
      });

      await waitForCondition(
        () => (deliveryFor(phoneB.deviceId)?.wake_attempt_count ?? 0) === 2,
        60_000,
        "B's wake ladder to take its second swing after the restart",
      );

      // Nothing may be handed to A: its content is out on a live lease.
      const rehandRes = await phoneRequest("/notifications/claim", phoneA, {});
      expect(
        rehandRes.status,
        "a surviving live lease must not be re-handed — a gateway that reset leases to pending at boot would answer 200 here",
      ).toBe(204);

      const firstConfirm = await phoneRequest("/notifications/confirm", phoneA, {
        id: leaseTokenA,
      });
      expect(firstConfirm.status).toBe(200);
      expect(await firstConfirm.json()).toEqual({ ok: true });
      const secondConfirm = await phoneRequest("/notifications/confirm", phoneA, {
        id: leaseTokenA,
      });
      expect(secondConfirm.status).toBe(404);

      const claimByB = await phoneRequest("/notifications/claim", phoneB, {});
      expect(claimByB.status).toBe(200);
      expect(await claimByB.json()).toMatchObject({
        title: TEST_PUSH_TITLE,
        body: TEST_PUSH_BODY,
        collapseId: TEST_PUSH_COLLAPSE_ID,
        remaining: 0,
      });

      const afterA = deliveryFor(phoneA.deviceId)!;
      const afterB = deliveryFor(phoneB.deviceId)!;
      expect(afterA.state).toBe("delivered");
      expect(afterA.delivered_at).not.toBeNull();
      expect(afterA.id).toBe(beforeA.id);
      // Same rows, same content — the restart re-rendered and re-queued nothing.
      expect(afterB.id).toBe(beforeB.id);
      expect(afterB.notification_id).toBe(beforeB.notification_id);
      expect(afterB.wake_attempt_count).toBe(2);
      expect(deliveryCountFor(phoneA.deviceId)).toBe(1);
      expect(deliveryCountFor(phoneB.deviceId)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a restart does not wipe and re-embed an index whose embedder never changed",
    async () => {
      // The precondition, asserted rather than inherited: whatever the test
      // above did, indexing is finished and the corpus is whole.
      await waitForIndexSettled(CORPUS_SIZE, "the index to settle before the no-wipe baseline");
      const before = readIndexDb((db) =>
        db
          .prepare<
            [],
            IndexedDocumentRow
          >("SELECT document_id, content_hash, chunk_count, indexed_at FROM indexed_documents ORDER BY document_id")
          .all(),
      );
      expect(before).toHaveLength(CORPUS_SIZE);
      const embedsBefore = harness.getEmbedCount();

      // No `whileStopped`: the fake embedder is a harness-owned server the
      // restart does not touch, so the new process probes the same model id and
      // dimension the previous run stamped.
      await harness.restartGateway();

      await harness.pushDocument({
        externalId: "restart-durability-doc-probe",
        title: "Studio Northstar service note, post-restart",
        content:
          "Post-restart service note for Studio Northstar: Jamie Lopez confirmed bay 61 is clear " +
          "and asked dispatch to call +1 (555) 010-0142 before the next collection.",
      });
      await waitForIndexSettled(
        CORPUS_SIZE + 1,
        "the post-restart document to be indexed (a wipe would have to re-embed the whole corpus to get here)",
      );

      const after = readIndexDb((db) =>
        db
          .prepare<
            [],
            IndexedDocumentRow
          >("SELECT document_id, content_hash, chunk_count, indexed_at FROM indexed_documents ORDER BY document_id")
          .all(),
      );
      const beforeIds = new Set(before.map((row) => row.document_id));
      const survivors = after.filter((row) => beforeIds.has(row.document_id));
      // `wipeAndRecreateVectorIndex` empties `content_hash` and stamps a fresh
      // `indexed_at` on every row, and the refill restores the hash but not the
      // timestamp, so a wipe-then-refill cannot reproduce this pair.
      expect(
        survivors,
        "boot re-derived the embedder identity and wiped the index; every restart would re-embed the whole corpus",
      ).toEqual(before);
      expect(harness.getEmbedCount() - embedsBefore).toBeLessThan(20);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a client holding a pre-restart event id is told to resync, not left waiting on a turn no server remembers",
    async () => {
      const beforeRes = await fetch(`${harness.gatewayUrl}/agent/events`, {
        headers: { Authorization: `Bearer ${harness.apiKey}`, Accept: "text/event-stream" },
      });
      expect(beforeRes.ok).toBe(true);
      const beforeStream = new SseReader(beforeRes.body!);
      let lastId = 0;
      try {
        const session = await harness.gatewayJson<{ sessionId: string }>("/agent/sessions", {
          method: "POST",
          body: "{}",
        });
        const sent = await harness.gatewayJson<{ messageId: string }>(
          `/agent/sessions/${encodeURIComponent(session.sessionId)}/messages`,
          { method: "POST", body: JSON.stringify({ text: AGENT_TRIGGER }) },
        );
        for (;;) {
          const block = await beforeStream.nextData(
            60_000,
            `the pre-restart turn to end (agent.message.end for ${sent.messageId})`,
          );
          if (block.id) lastId = Math.max(lastId, Number(block.id));
          const event = JSON.parse(block.data!) as {
            type: string;
            payload?: { messageId?: string };
          };
          if (
            (event.type === "agent.message.end" || event.type === "agent.error") &&
            event.payload?.messageId === sent.messageId
          ) {
            break;
          }
        }
      } finally {
        await beforeStream.close();
      }
      expect(
        lastId,
        "the pre-restart turn must have framed at least one resumable event id, or the resync below is trivially satisfied",
      ).toBeGreaterThan(0);

      await harness.restartGateway();

      // `harness.apiKey` is re-read here: the harness reassigns it on every boot.
      const afterRes = await fetch(`${harness.gatewayUrl}/agent/events`, {
        headers: {
          Authorization: `Bearer ${harness.apiKey}`,
          Accept: "text/event-stream",
          "Last-Event-ID": String(lastId),
        },
      });
      expect(afterRes.ok).toBe(true);
      const afterStream = new SseReader(afterRes.body!);
      try {
        const resync = await afterStream.nextData(
          30_000,
          "the reconnect to be answered with a control frame",
        );
        expect(
          JSON.parse(resync.data!),
          "a client whose cursor is ahead of the fresh sequence must be told to reload the persisted transcript",
        ).toEqual({ kind: "event", type: "agent.resync", payload: {} });
        // Asserted against the raw block: an `id:` line here would re-anchor
        // the client's EventSource cursor on a position no server has.
        expect(resync.raw.split("\n").some((line) => line.startsWith("id:"))).toBe(false);

        const session = await harness.gatewayJson<{ sessionId: string }>("/agent/sessions", {
          method: "POST",
          body: "{}",
        });
        await harness.gatewayJson(
          `/agent/sessions/${encodeURIComponent(session.sessionId)}/messages`,
          { method: "POST", body: JSON.stringify({ text: AGENT_TRIGGER }) },
        );
        for (;;) {
          const block = await afterStream.next(
            60_000,
            "the first framed event id after the restart",
          );
          if (!block.id) continue;
          expect(
            block.id,
            "the first event of the new process must be id 1 — nothing else may emit an agent event between boot and this message (check the brain gate and the background-agent assignment)",
          ).toBe("1");
          break;
        }
      } finally {
        await afterStream.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an answer interrupted by a restart fails, frees its conversation, and the same request id restarts the task in place",
    async () => {
      await probeGatedReviewer();
      const answerBody = JSON.stringify({
        question: ANSWER_QUESTION,
        clientRequestId: ANSWER_REQUEST_ID,
        workflowName: "Delivery desk",
        workflowPurpose: "Answer courier scheduling questions for open orders.",
      });
      const postAnswer = (): Promise<Response> =>
        fetch(`${harness.gatewayUrl}/answer`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${harness.apiKey}`,
            "Content-Type": "application/json",
          },
          body: answerBody,
        });

      const taskRow = (): AnswerTaskRow | undefined =>
        readDb((db) =>
          db
            .prepare<[string], AnswerTaskRow>(
              `SELECT id, status, conversation_id, resolved_at, candidate_answer
                 FROM answer_tasks WHERE client_request_id = ?`,
            )
            .get(ANSWER_REQUEST_ID),
        );
      const taskCount = (): number =>
        readDb(
          (db) =>
            db
              .prepare<
                [string],
                { count: number }
              >("SELECT COUNT(*) AS count FROM answer_tasks WHERE client_request_id = ?")
              .get(ANSWER_REQUEST_ID)!.count,
        );
      const externalRequests = (taskId: string): number =>
        readDb(
          (db) =>
            db
              .prepare<[string], { count: number }>(
                `SELECT COUNT(*) AS count FROM answer_audit_events
                   WHERE task_id = ? AND event_type = 'external_request'`,
              )
              .get(taskId)!.count,
        );

      gate.hold = true;
      const callsBefore = gate.calls;
      const first = postAnswer();
      pendingAnswers.push(first.then(() => undefined).catch(() => undefined));

      await waitForCondition(
        () => taskRow()?.status === "running" && gate.calls > callsBefore,
        90_000,
        "the answer task to reach `running` with its privacy review held open at the model",
      );
      const started = taskRow()!;
      const taskId = started.id;
      expect(
        readDb((db) =>
          db
            .prepare<
              [string],
              { active_task_id: string | null }
            >("SELECT active_task_id FROM answer_conversations WHERE id = ?")
            .get(started.conversation_id),
        ),
        "the conversation must be held by this task before the restart, or freeing it afterwards proves nothing",
      ).toEqual({ active_task_id: taskId });

      const tokenBefore = harness.apiKey;
      await harness.restartGateway();
      expect(
        harness.apiKey,
        "the admin token is the caller identity behind this request id; a rotated token would make the repeat below a different owner's ask",
      ).toBe(tokenBefore);

      // Recovery runs inside `bootAgent()`, which can finish after /health
      // starts answering — so poll the persisted row, never a single read.
      await waitForCondition(
        () => taskRow()?.status === "failed",
        60_000,
        "the interrupted answer task to be recovered as failed at boot",
      );
      const recovered = taskRow()!;
      expect(recovered.resolved_at).not.toBeNull();
      expect(recovered.candidate_answer).toBeNull();
      expect(
        readDb((db) =>
          db
            .prepare<
              [string],
              { active_task_id: string | null }
            >("SELECT active_task_id FROM answer_conversations WHERE id = ?")
            .get(started.conversation_id),
        ),
        "a conversation still pinned to a dead task is `conversation_busy` forever",
      ).toEqual({ active_task_id: null });
      const audit = readDb((db) =>
        db
          .prepare<[string], { display_json: string; payload_json: string | null }>(
            `SELECT e.display_json, p.payload_json
               FROM answer_audit_events e
               LEFT JOIN answer_audit_payloads p ON p.event_id = e.id
              WHERE e.task_id = ? AND e.event_type = 'failed'`,
          )
          .get(taskId),
      );
      expect(audit?.display_json).toContain("Answer interrupted");
      expect(audit?.payload_json).toContain("gateway_restart");

      await probeGatedReviewer();
      let secondStatus: number | undefined;
      const second = postAnswer();
      pendingAnswers.push(second.then(() => undefined).catch(() => undefined));
      void second.then(
        (res) => {
          secondStatus = res.status;
        },
        () => {
          secondStatus = -1;
        },
      );

      await waitForCondition(
        () => secondStatus !== undefined || externalRequests(taskId) === 2,
        90_000,
        "the repeat of the same request id to be taken up by the recovered task (or refused)",
      );
      expect(
        secondStatus,
        "the repeat must be adopted by the failed task, not answered with a conflict — a poisoned request id leaves the caller no way forward",
      ).toBeUndefined();
      const restarted = taskRow()!;
      expect(restarted.id).toBe(taskId);
      expect(restarted.status).toBe("running");
      expect(taskCount()).toBe(1);
      expect(externalRequests(taskId)).toBe(2);
      // The second ask is left in flight on purpose: `afterAll` kills the
      // gateway, so the reviewer never takes its abort path and no write races
      // teardown.
    },
    TEST_TIMEOUT_MS,
  );
});
