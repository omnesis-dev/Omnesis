// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Benchmark and parity capture for `GET /admin/privacy/exchanges`, the
 * Privacy page's exchange feed, on a large, encrypted, invented history.
 *
 *   npx tsx scripts/bench-privacy-exchanges.mts build   <dir> [tasks=3000] [transcriptScale=1]
 *   npx tsx scripts/bench-privacy-exchanges.mts measure <dir> [runs=7]
 *   npx tsx scripts/bench-privacy-exchanges.mts capture <dir> <out.json>
 *   npx tsx scripts/bench-privacy-exchanges.mts explain <dir>
 *
 * `build` creates `<dir>/omnesis.db` with the full gateway schema, keyed like
 * a production store, and records invented Answer exchanges over six months
 * through the privacy store's own mutations: several external agents (device
 * tokens, OAuth principals and a paired integration), multi-turn
 * conversations, released, reduced, held, approved, denied, expired, failed,
 * canceled and running exchanges, retried generations, recorded egress, and
 * the agent transcript of every generation — most of them tens of kilobytes,
 * some a few megabytes, as a model reading documents through its tools
 * produces. `measure` opens the store the way the gateway's main thread does
 * (read-only, the default page cache), starts an io read worker the way the
 * gateway does, and requests the route through its real mount, recording
 * request latency and the longest event-loop block (`monitorEventLoopDelay`).
 * Each run opens a fresh handle and worker, so its first request pays
 * decryption like a request after the cache has turned over; a second request
 * on the same handle is the warm case. `capture` writes the status and body
 * of every behaviour case, so two checkouts' outputs can be diffed for parity.
 *
 * Copy the script into another checkout to measure that checkout's route: it
 * imports the route code relative to its own location, and a checkout whose
 * privacy service takes no read port ignores the one offered. Never point it
 * at a live config directory; it writes the store it measures.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Hono } from "hono";

import { SCOPE_ADMIN } from "@omnesis/types";
import { createDatabase, openReadOnlyDatabase } from "../packages/gateway/src/db.js";
import { Scheduler } from "../packages/gateway/src/scheduler/scheduler.js";
import { IoTaskRunner } from "../packages/gateway/src/scheduler/runners/io.js";
import { ioGateFromScheduler } from "../packages/gateway/src/scheduler/io-ops.js";
import {
  appendAnswerAuditEvent,
  auditDisplay,
  beginAnswerTask,
  completeAnswerTask,
  digestCandidate,
  failAnswerTask,
  recordAnswerEgress,
  resolvePrivacyApproval,
} from "../packages/gateway/src/privacy/store.js";
import { PrivacyAdminService } from "../packages/gateway/src/privacy/admin-service.js";
import { errorResponse, HttpError } from "../packages/gateway/src/http/errors.js";
import { strictRoute } from "../packages/gateway/src/http/scope.js";
import { mountPrivacyRoutes } from "../packages/gateway/src/http/routes/privacy.js";
import type Database from "better-sqlite3";
import type { AnswerCitation, PrivacyReviewRecord } from "@omnesis/types/privacy";

const [mode, dir, arg, scaleArg] = process.argv.slice(2);
if (!mode || !dir) {
  console.error("usage: bench-privacy-exchanges.mts build|measure|capture|explain <dir> [arg]");
  process.exit(2);
}
const dbPath = join(dir, "omnesis.db");
const keyPath = join(dir, "key.hex");
const casesPath = join(dir, "cases.json");
/** The gateway's default main-thread page cache (`runtime-settings.ts`). */
const READ_CACHE_BYTES = 256 * 1024 * 1024;
const WORKER_URL = new URL("../packages/gateway/src/workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../packages/gateway/src/workers/register-tsx.mjs", import.meta.url)
  .href;
const DAY_MS = 24 * 60 * 60 * 1_000;

// ── deterministic invented content ─────────────────────────────────────────

let seed = 0x5eed4321;
function random(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function pick<T>(values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}
const WORDS =
  "quarterly budget review marathon entry heart rate trend studio northstar riverside estate stellar sound invoice draft agenda follow up schedule venue catering summary notes travel itinerary garden supplies weekly report checklist renewal reminder".split(
    " ",
  );
function text(minBytes: number, maxBytes: number): string {
  const target = minBytes + Math.floor(random() * (maxBytes - minBytes));
  const out: string[] = [];
  let length = 0;
  while (length < target) {
    const word = pick(WORDS);
    out.push(word);
    length += word.length + 1;
  }
  return out.join(" ");
}

/**
 * A transcript's size: mostly tens of kilobytes, a tail of megabytes, times
 * the build's scale, and never past the audit's 8 MiB per-event budget.
 */
const TRANSCRIPT_SCALE = Number(scaleArg ?? 1);
function traceBytes(): number {
  const roll = random();
  const bytes =
    roll < 0.6
      ? 20_000 + Math.floor(random() * 60_000)
      : roll < 0.9
        ? 100_000 + Math.floor(random() * 300_000)
        : 1_000_000 + Math.floor(random() * 2_000_000);
  return Math.min(Math.floor(bytes * TRANSCRIPT_SCALE), 7_500_000);
}

function agentTrace(bytes: number, terminal: { stop?: string; failureText?: string } = {}) {
  const messages: unknown[] = [
    { role: "user", parts: [{ kind: "text", text: "A fictional planning question." }] },
  ];
  let used = 0;
  let call = 0;
  while (used < bytes) {
    const chunk = Math.min(40_000, bytes - used + 100);
    const toolCallId = `call-${call++}`;
    messages.push({
      role: "assistant",
      parts: [
        { kind: "thinking", text: text(200, 600) },
        { kind: "tool_use", toolCallId, tool: "search", args: { query: text(10, 40) } },
      ],
    });
    messages.push({
      role: "user",
      parts: [{ kind: "tool_result", toolCallId, result: { documents: [text(chunk, chunk + 1)] } }],
    });
    used += chunk;
  }
  messages.push({
    role: "assistant",
    parts: [{ kind: "text", text: terminal.failureText ?? text(200, 1_200) }],
  });
  return {
    provider: "synthetic-provider",
    model: "synthetic-model",
    sessionId: `session-${Math.floor(random() * 1e9)}`,
    messages,
    subagentEvents: [],
    terminalStopReason: terminal.stop ?? "end_turn",
  };
}

function citations(count: number): AnswerCitation[] {
  return Array.from({ length: count }, (_, index) => ({
    documentId: `00000000-0000-4000-8000-${String(Math.floor(random() * 1e12)).padStart(12, "0")}`,
    sourceType: pick(["gmail", "calendar", "notes", "files"]),
    title: text(10, 50),
    timestamp: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    ...(random() < 0.5 ? { sourceUrl: `https://mail.example.com/m/${index}` } : {}),
  }));
}

function review(fallbackCause: PrivacyReviewRecord["fallbackCause"]): PrivacyReviewRecord {
  return {
    recipeVersion: "privacy-reviewer-v2",
    provider: "synthetic-provider",
    model: "synthetic-reviewer",
    confidence: 0.9,
    policyRevision: "policy-a",
    fallbackCause,
    findings: [
      {
        category: "schedule",
        detailLevel: "summary",
        subject: "user",
        disposition: "allow",
        description: "General schedule information.",
      },
    ],
    rationale: "The fictional policy permits a schedule summary.",
  };
}

// ── build ──────────────────────────────────────────────────────────────────

interface Cases {
  /** The clock every request is answered at: after the last exchange. */
  now: number;
  /** Which kinds of exchange the fixture holds, for the capture's report. */
  outcomes: Record<string, number>;
}

function seedOwners(db: Database.Database, at: number): string[] {
  const owners: string[] = [];
  const device = db.prepare(
    "INSERT INTO devices (id, name, kind, capabilities, paired_at) VALUES (?, ?, ?, ?, ?)",
  );
  const token = db.prepare(
    "INSERT INTO tokens (id, device_id, token_hash, name, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [index, [deviceName, tokenName]] of [
    ["Studio Northstar laptop", "Atlas (openclaw)"],
    ["Riverside desk", "paired"],
    ["Stellar Sound agent", "Planning helper"],
  ].entries()) {
    const deviceId = `bench-device-${index}`;
    device.run(deviceId, deviceName, "agent", "{}", at);
    token.run(`bench-token-${index}`, deviceId, `hash-${index}`, tokenName, at);
    owners.push(`token:bench-token-${index}`);
  }
  // A paired integration that answers on its own behalf.
  device.run(
    "bench-integration",
    "Hermes on the studio box",
    "agent",
    JSON.stringify({ agentIntegration: { harness: "hermes" } }),
    at,
  );
  owners.push("device:bench-integration");
  // OAuth principals, one of them through a registered client.
  db.prepare(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, response_types,
       token_endpoint_auth_method, created_at)
     VALUES ('bench-client', 'Example Desktop', '["http://127.0.0.1/cb"]', '["authorization_code"]',
       '["code"]', 'none', ?)`,
  ).run(at);
  for (const index of [0, 1]) {
    db.prepare(
      "INSERT INTO access_principals (id, name, kind, created_at, updated_at) VALUES (?, ?, 'interactive', ?, ?)",
    ).run(`bench-principal-${index}`, `Example agent ${index}`, at, at);
    db.prepare(
      "INSERT INTO access_grants (id, principal_id, name, revision, created_at, updated_at) VALUES (?, ?, 'Answer', 1, ?, ?)",
    ).run(`bench-grant-${index}`, `bench-principal-${index}`, at, at);
    db.prepare(
      `INSERT INTO principal_credentials (id, grant_id, oauth_client_id, kind, label, created_at)
       VALUES (?, ?, 'bench-client', 'interactive', ?, ?)`,
    ).run(`bench-credential-${index}`, `bench-grant-${index}`, `Connection ${index}`, at);
    owners.push(
      `principal:bench-principal-${index}:grant:bench-grant-${index}:credential:bench-credential-${index}:answer-scope:scope${index}`,
    );
  }
  // An owner nothing resolves, which keeps the generic label.
  owners.push("token:bench-token-missing");
  return owners;
}

function build(tasks: number): void {
  mkdirSync(dir!, { recursive: true });
  if (existsSync(dbPath)) throw new Error(`${dbPath} exists; build into an empty directory`);
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("hex"));
  const db = createDatabase(dbPath, { encryptionKey: key });
  const start = Date.parse("2026-05-01T08:00:00Z");
  const span = 180 * DAY_MS;
  const owners = seedOwners(db, start - DAY_MS);
  const outcomes: Record<string, number> = {};
  const count = (name: string) => (outcomes[name] = (outcomes[name] ?? 0) + 1);
  let serial = 0;
  let conversation = 0;
  let clock = start;
  const now = start + span + DAY_MS;
  while (serial < tasks) {
    conversation += 1;
    const ownerId = pick(owners);
    const turns = 1 + Math.floor(random() * 4);
    const workflowId = `bench-workflow-${conversation}`;
    const conversationId = `bench-conversation-${conversation}`;
    for (let turn = 0; turn < turns && serial < tasks; turn++) {
      serial += 1;
      // Spread over the span, with bursts; some share one millisecond so the
      // cursor's id tie-break is exercised.
      clock += random() < 0.05 ? 0 : Math.floor(random() * ((2 * span) / tasks));
      const taskId = `bench-task-${String(serial).padStart(6, "0")}`;
      // Running and pending exchanges are the newest; everything older is settled.
      const recent = serial > tasks - 12;
      const roll = random();
      const kind = recent
        ? pick(["running", "pending", "pending-expired", "release"] as const)
        : roll < 0.5
          ? "release"
          : roll < 0.6
            ? "reduce"
            : roll < 0.64
              ? "approved"
              : roll < 0.67
                ? "user-denied"
                : roll < 0.7
                  ? "expired"
                  : roll < 0.74
                    ? "privacy-denied"
                    : roll < 0.76
                      ? "hard-stop"
                      : roll < 0.79
                        ? "approval-not-available"
                        : roll < 0.9
                          ? "failed"
                          : roll < 0.93
                            ? "failed-legacy"
                            : roll < 0.95
                              ? "canceled"
                              : "release";
      beginAnswerTask(db, {
        ownerId,
        clientRequestId: `bench-request-${serial}`,
        question: `${text(30, 160)}?`,
        workflowName: `Planning workflow ${conversation}`,
        workflowPurpose: "Prepare a fictional planning summary.",
        // A follow-up turn continues the conversation its first turn opened.
        ...(turn > 0 ? { conversationId } : {}),
        ids: { workflowId, conversationId, taskId },
        now: clock,
        workflowExpiresAt: clock + 365 * DAY_MS,
      });
      // One generation, sometimes retried; every attempt keeps its transcript.
      const attempts = random() < 0.15 ? 2 + Math.floor(random() * 2) : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const failureText =
          kind === "failed-legacy" && attempt === attempts - 1
            ? pick([
                "Model request failed: http_request_error: connection refused",
                "Model request failed: http_empty_response: Model returned an empty response (finish_reason=length).",
              ])
            : undefined;
        appendAnswerAuditEvent(db, {
          id: `bench-trace-${serial}-${attempt}`,
          taskId,
          ownerId,
          kind: "agent_trace",
          display: auditDisplay({ title: "Agent activity", text: "Read-only model activity." }),
          payload: agentTrace(traceBytes(), {
            ...(kind === "canceled" ? { stop: "canceled" } : {}),
            ...(failureText ? { failureText } : {}),
          }),
          now: clock + 1 + attempt,
        });
      }
      const answer = text(200, 2_500);
      const cited = citations(random() < 0.6 ? 1 + Math.floor(random() * 6) : 0);
      const hasCandidate = !["failed", "failed-legacy", "canceled", "running"].includes(kind);
      if (hasCandidate || (kind === "failed" && random() < 0.3)) {
        appendAnswerAuditEvent(db, {
          id: `bench-candidate-${serial}`,
          taskId,
          ownerId,
          kind: "candidate_generated",
          display: auditDisplay({
            title: "Candidate inside Omnesis",
            text: answer.slice(0, 160),
            digest: digestCandidate(answer, cited),
          }),
          payload: {
            candidateAnswer: answer,
            candidateCitations: cited,
            candidateDigest: digestCandidate(answer, cited),
          },
          now: clock + 10,
        });
      }
      const at = clock + 20;
      const disclosureRevision = () =>
        db
          .prepare<[string], { revision: number }>(
            "SELECT revision FROM answer_workflow_disclosure WHERE workflow_id = ?",
          )
          .get(workflowId)!.revision;
      const hold = (approvalId: string, expiresAt: number, fallback = "policy_requires_review") =>
        completeAnswerTask(db, {
          taskId,
          ownerId,
          review: review(fallback as PrivacyReviewRecord["fallbackCause"]),
          now: at,
          outcome: {
            kind: "approval",
            approvalId,
            candidateAnswer: answer,
            candidateCitations: cited,
            candidateDigest: digestCandidate(answer, cited),
            releaseStatus: random() < 0.3 ? "released_with_reductions" : "released",
            reductions: random() < 0.3 ? ["Exact timing removed"] : [],
            expiresAt,
          },
        });
      const egress = (endpoint: "/answer" | "/answer/tasks/:id", offset: number) =>
        recordAnswerEgress(db, {
          id: `bench-egress-${serial}-${offset}`,
          taskId,
          ownerId,
          endpoint,
          includeCitations: random() < 0.7,
          now: at + offset,
        });
      switch (kind) {
        case "running":
          break;
        case "release":
        case "reduce":
          completeAnswerTask(db, {
            taskId,
            ownerId,
            review: review(random() < 0.05 ? "low_confidence" : null),
            now: at,
            outcome:
              kind === "release"
                ? {
                    kind: "release",
                    releaseId: `bench-release-${serial}`,
                    answer,
                    citations: cited,
                    expectedDisclosureRevision: disclosureRevision(),
                  }
                : {
                    kind: "reduce",
                    releaseId: `bench-release-${serial}`,
                    answer,
                    citations: cited,
                    reductions: ["Exact timing removed", "A name generalized"],
                    expectedDisclosureRevision: disclosureRevision(),
                  },
          });
          // Most releases are collected; a few never are.
          if (random() < 0.85) egress("/answer", 1);
          if (random() < 0.2) egress("/answer", 2);
          break;
        case "pending":
          hold(`bench-approval-${serial}`, now + DAY_MS);
          break;
        case "pending-expired":
          // Lapsed but not yet swept: presented as an expired denial.
          hold(`bench-approval-${serial}`, now - 60_000);
          break;
        case "approved":
          hold(`bench-approval-${serial}`, at + DAY_MS, "low_confidence");
          resolvePrivacyApproval(db, {
            approvalId: `bench-approval-${serial}`,
            action: "approve",
            requestContext: { requestId: `bench-admin-${serial}`, tokenId: null, deviceId: null },
            releaseId: `bench-release-${serial}`,
            now: at + 100,
          });
          if (random() < 0.7) egress("/answer/tasks/:id", 200);
          break;
        case "user-denied":
          hold(`bench-approval-${serial}`, at + DAY_MS);
          resolvePrivacyApproval(db, {
            approvalId: `bench-approval-${serial}`,
            action: "deny",
            requestContext: { requestId: `bench-admin-${serial}`, tokenId: null, deviceId: null },
            releaseId: `bench-unused-${serial}`,
            now: at + 100,
          });
          break;
        case "expired":
          hold(`bench-approval-${serial}`, at + 1_000);
          // What the periodic sweep writes once the approval lapses.
          db.prepare(
            "UPDATE answer_approvals SET status = 'expired', resolved_at = ? WHERE task_id = ?",
          ).run(at + 2_000, taskId);
          db.prepare(
            `UPDATE answer_tasks SET status = 'denied', denial_reason = 'expired',
               candidate_answer = NULL, candidate_digest = NULL, resolved_at = ? WHERE id = ?`,
          ).run(at + 2_000, taskId);
          break;
        case "privacy-denied":
        case "hard-stop":
        case "approval-not-available":
          completeAnswerTask(db, {
            taskId,
            ownerId,
            review: review(kind === "hard-stop" ? "hard_stop" : "policy_requires_review"),
            now: at,
            outcome: {
              kind: "deny",
              reason:
                kind === "hard-stop"
                  ? "hard_stop"
                  : kind === "privacy-denied"
                    ? "privacy_policy"
                    : "approval_not_available",
            },
          });
          break;
        case "failed":
          failAnswerTask(
            db,
            taskId,
            ownerId,
            at,
            pick([
              { code: "http_empty_response", message: "Model returned an empty response." },
              {
                code: "review_failed",
                message: "The privacy check could not finish.",
                detail: "The reviewer timed out.",
              },
              undefined,
            ]),
          );
          break;
        case "failed-legacy":
          failAnswerTask(db, taskId, ownerId, at);
          break;
        case "canceled":
          // Stored by earlier gateways; nothing writes it now.
          db.prepare(
            "UPDATE answer_tasks SET status = 'canceled', resolved_at = ? WHERE id = ?",
          ).run(at, taskId);
          db.prepare(
            "UPDATE answer_conversations SET active_task_id = NULL WHERE active_task_id = ?",
          ).run(taskId);
          break;
      }
      count(kind);
      clock = at + 1_000;
      // An exchange still running or held keeps its conversation busy.
      if (kind === "running" || kind === "pending" || kind === "pending-expired") break;
    }
    if (serial % 200 === 0) process.stdout.write(`\r${serial} exchanges`);
  }
  // Operational reviewer failures inside and just outside the 24-hour window.
  db.prepare(
    `UPDATE answer_tasks SET review_json = json_set(review_json, '$.fallbackCause', 'request_failed')
      WHERE id IN (SELECT id FROM answer_tasks WHERE review_json IS NOT NULL
                    ORDER BY created_at DESC LIMIT 4)`,
  ).run();
  const cases: Cases = { now, outcomes };
  writeFileSync(casesPath, JSON.stringify(cases, null, 2));
  db.pragma("wal_checkpoint(TRUNCATE)");
  const pages = db.pragma("page_count", { simple: true }) as number;
  const pageSize = db.pragma("page_size", { simple: true }) as number;
  db.close();
  console.log(
    `\nbuilt ${serial} exchanges in ${conversation} conversations (${((pages * pageSize) / 1024 / 1024).toFixed(0)} MiB) in ${dbPath}`,
  );
  console.log(outcomes);
}

// ── the route, mounted the way the gateway mounts it ───────────────────────

function loadKey(): string {
  return readFileSync(keyPath, "utf8").trim();
}

function loadCases(): Cases {
  return JSON.parse(readFileSync(casesPath, "utf8")) as Cases;
}

async function startWorker() {
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath: dbPath,
      gatewayDbKeyHex: loadKey(),
      concurrency: 1,
      cacheSizeBytes: READ_CACHE_BYTES,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    }),
  );
  await scheduler.start();
  return { scheduler, gate: ioGateFromScheduler(scheduler) };
}

async function openApp(now: number) {
  const db = openReadOnlyDatabase(dbPath, {
    encryptionKey: Buffer.from(loadKey(), "hex"),
    cacheSizeBytes: READ_CACHE_BYTES,
  });
  const worker = await startWorker();
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    throw err;
  });
  app.use("*", async (c, next) => {
    c.set("requestId" as never, "bench-request" as never);
    c.set(
      "auth" as never,
      {
        authMethod: "bearer",
        deviceId: null,
        credentialDeviceId: null,
        tokenId: null,
        scopes: [SCOPE_ADMIN],
      } as never,
    );
    await next();
  });
  mountPrivacyRoutes(strictRoute(app as never), {
    privacyAdminService: new PrivacyAdminService({
      db,
      // The feed only reads; the policy store and the writer are never reached.
      policyStore: {} as never,
      writeGate: {} as never,
      now: () => now,
      // The gateway's read worker. A checkout whose service reads on the main
      // handle ignores it.
      ...({ exchangeReads: worker.gate } as object),
    }),
  } as never);
  return {
    app,
    close: async () => {
      await worker.scheduler.dispose();
      db.close();
    },
  };
}

async function get(app: Hono, path: string): Promise<{ status: number; body: string }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.text() };
}

/** Every page of the feed, newest first, following the cursor to the end. */
async function walk(app: Hono, limit: number): Promise<Array<{ path: string; body: string }>> {
  const pages: Array<{ path: string; body: string }> = [];
  let cursor: string | null = null;
  do {
    const path = `/admin/privacy/exchanges?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const { status, body } = await get(app, path);
    if (status !== 200) throw new Error(`${path} answered ${status}`);
    pages.push({ path, body });
    cursor = (JSON.parse(body) as { nextCursor: string | null }).nextCursor;
  } while (cursor);
  return pages;
}

async function capture(out: string): Promise<void> {
  const cases = loadCases();
  const { app, close } = await openApp(cases.now);
  const results: Array<{ name: string; status: number; body: string }> = [];
  const record = async (name: string, path: string) =>
    results.push({ name, ...(await get(app, path)) });
  await record("first page, default limit", "/admin/privacy/exchanges");
  await record("first page, limit 1", "/admin/privacy/exchanges?limit=1");
  await record("first page, limit 100", "/admin/privacy/exchanges?limit=100");
  await record("limit above the cap", "/admin/privacy/exchanges?limit=500");
  await record("invalid limit", "/admin/privacy/exchanges?limit=zero");
  await record("invalid cursor", "/admin/privacy/exchanges?cursor=not-a-cursor");
  await record(
    "cursor with a wrong shape",
    `/admin/privacy/exchanges?cursor=${Buffer.from(JSON.stringify({ createdAt: "x", id: "" })).toString("base64url")}`,
  );
  await record(
    "cursor past the oldest exchange",
    `/admin/privacy/exchanges?cursor=${Buffer.from(JSON.stringify({ createdAt: 1, id: "a" })).toString("base64url")}`,
  );
  // Every page of the whole history, through the cursor: middle and last pages.
  for (const limit of [50, 37]) {
    const pages = await walk(app, limit);
    pages.forEach((page, index) =>
      results.push({
        name: `walk limit ${limit}, page ${index + 1}`,
        status: 200,
        body: page.body,
      }),
    );
  }
  // The conversation detail shares the feed's read: every conversation with a
  // failed, canceled or held exchange, and a sample of the rest, paged two at
  // a time, with and without one exchange's transcripts.
  const conversations = new Map<string, string[]>();
  const failing = new Set<string>();
  for (const page of await walk(app, 100)) {
    const body = JSON.parse(page.body) as {
      exchanges: Array<{ conversationId: string; taskId: string; status: string }>;
    };
    for (const exchange of body.exchanges) {
      conversations.set(exchange.conversationId, [
        ...(conversations.get(exchange.conversationId) ?? []),
        exchange.taskId,
      ]);
      if (exchange.status !== "released" && exchange.status !== "released_with_reductions")
        failing.add(exchange.conversationId);
    }
  }
  let sampled = 0;
  for (const [conversationId, taskIds] of conversations) {
    if (!failing.has(conversationId) && sampled++ % 10 !== 0) continue;
    const base = `/admin/privacy/conversations/${encodeURIComponent(conversationId)}/exchanges`;
    await record(`detail ${conversationId}`, base);
    let cursor: string | null = null;
    let page = 0;
    do {
      const path = `${base}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const { status, body } = await get(app, path);
      results.push({ name: `detail ${conversationId} limit 2 page ${++page}`, status, body });
      cursor =
        status === 200
          ? (JSON.parse(body) as { previousCursor: string | null }).previousCursor
          : null;
    } while (cursor);
    for (const taskId of taskIds) {
      await record(
        `detail ${conversationId} with transcripts of ${taskId}`,
        `${base}?includeAgentTracesTaskId=${encodeURIComponent(taskId)}`,
      );
    }
  }
  await record(
    "detail of a missing conversation",
    "/admin/privacy/conversations/bench-conversation-missing/exchanges",
  );
  await record(
    "detail of a missing conversation with an invalid cursor",
    "/admin/privacy/conversations/bench-conversation-missing/exchanges?cursor=not-a-cursor",
  );
  const [firstConversation] = conversations.keys();
  if (firstConversation) {
    await record(
      "detail with an invalid cursor",
      `/admin/privacy/conversations/${encodeURIComponent(firstConversation)}/exchanges?cursor=not-a-cursor`,
    );
  }
  await record("reviewer health", "/admin/privacy/reviewer-health");
  writeFileSync(out, JSON.stringify(results, null, 2));
  const digest = createHash("sha256").update(JSON.stringify(results)).digest("hex");
  console.log(`${results.length} responses, sha256 ${digest}`);
  await close();
}

async function timed(
  app: Hono,
  path: string,
): Promise<{ ms: number; blockedMs: number; status: number }> {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const started = performance.now();
  const res = await app.request(path);
  await res.arrayBuffer();
  const ms = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 5));
  histogram.disable();
  return { ms, blockedMs: histogram.max / 1e6, status: res.status };
}

function summary(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return `median ${median.toFixed(1)} ms, worst ${sorted.at(-1)!.toFixed(1)} ms`;
}

async function measure(runs: number): Promise<void> {
  const cases = loadCases();
  // A middle page's cursor, found once.
  const probe = await openApp(cases.now);
  let middle: string;
  {
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const { body } = await get(
        probe.app,
        `/admin/privacy/exchanges?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      cursor = (JSON.parse(body) as { nextCursor: string | null }).nextCursor;
      if (!cursor) break;
    }
    middle = cursor ?? "";
  }
  await probe.close();
  const probes: Array<[string, string]> = [
    ["first page (limit 50)", "/admin/privacy/exchanges"],
    ["first page (limit 100)", "/admin/privacy/exchanges?limit=100"],
    [
      "page 21 (limit 50)",
      `/admin/privacy/exchanges?limit=50&cursor=${encodeURIComponent(middle)}`,
    ],
  ];
  const rssBefore = process.memoryUsage().rss;
  for (const [name, path] of probes) {
    const cold = { ms: [] as number[], blocked: [] as number[] };
    const warm = { ms: [] as number[], blocked: [] as number[] };
    for (let run = 0; run < runs; run++) {
      const { app, close } = await openApp(cases.now);
      const first = await timed(app, path);
      const second = await timed(app, path);
      if (first.status !== 200 || second.status !== 200) throw new Error(`${path} failed`);
      cold.ms.push(first.ms);
      cold.blocked.push(first.blockedMs);
      warm.ms.push(second.ms);
      warm.blocked.push(second.blockedMs);
      await close();
    }
    console.log(name);
    console.log(`  fresh handle  latency ${summary(cold.ms)}; blocked ${summary(cold.blocked)}`);
    console.log(`  warm handle   latency ${summary(warm.ms)}; blocked ${summary(warm.blocked)}`);
  }
  console.log(
    `rss growth over the run: ${((process.memoryUsage().rss - rssBefore) / 1024 / 1024).toFixed(0)} MiB`,
  );
}

function explain(): void {
  const db = openReadOnlyDatabase(dbPath, { encryptionKey: Buffer.from(loadKey(), "hex") });
  const stats = db
    .prepare<[], { tasks: number; events: number; payload_mib: number }>(
      `SELECT (SELECT COUNT(*) FROM answer_tasks) AS tasks,
              (SELECT COUNT(*) FROM answer_audit_events) AS events,
              (SELECT SUM(length(CAST(payload_json AS BLOB))) / 1048576.0 FROM answer_audit_payloads) AS payload_mib`,
    )
    .get();
  console.log(stats);
  db.close();
}

if (mode === "build") build(Number(arg ?? 3_000));
else if (mode === "measure") await measure(Number(arg ?? 7));
else if (mode === "capture") await capture(arg ?? join(dir, "capture.json"));
else if (mode === "explain") explain();
else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
// A disposed io worker can leave a handle that keeps the process alive.
process.exit(0);
