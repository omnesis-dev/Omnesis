// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The scripted decision server against the gateway's own TypeSafe client —
 * the contract the E2E suites depend on, proven without booting a gateway.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { TypeSafeDecision } from "@omnesis/gateway/src/inference/decision/typesafe-client.js";
import { startDecisionServer, type DecisionServer } from "./decision-server.js";
import {
  WORTH_MAIL,
  worthAnswersFor,
  worthGateCassetteLines,
  worthMailBySubject,
  worthRequestFor,
} from "./worth-gate-mail.js";

let server: DecisionServer | null = null;
let tempDir: string | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

const API_KEY = "bench_typesafe_key_0123456789";

function clientFor(s: DecisionServer, apiKey = API_KEY) {
  return new TypeSafeDecision({
    url: s.endpoint,
    model: s.modelId,
    apiKey,
    allowRemoteInference: false,
    maxRetries: 0,
  });
}

describe("scripted decision server", () => {
  test("a policy function answers through the production client, and every call is recorded", async () => {
    server = await startDecisionServer({
      policy: (request) =>
        worthAnswersFor(worthMailBySubject((request.state as { subject: string }).subject)!),
      inputTokens: 321,
    });
    const result = await clientFor(server).decide(worthRequestFor(WORTH_MAIL.booking));
    expect(result).toMatchObject({
      model: server.modelId,
      inputTokens: 321,
      answers: { worth_score: { type: "score", score: WORTH_MAIL.booking.score } },
    });
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.authorization).toBe(`Bearer ${API_KEY}`);
    expect(server.calls[0]!.request).toEqual({
      model: server.modelId,
      ...worthRequestFor(WORTH_MAIL.booking),
    });
    expect(server.callsForSubject(WORTH_MAIL.booking.title)).toHaveLength(1);
  });

  test("cassette mode answers a recorded request and fails a miss loudly with its fingerprint", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "decision-server-"));
    writeFileSync(join(tempDir, "gate.jsonl"), `${worthGateCassetteLines().join("\n")}\n`);
    server = await startDecisionServer({ policy: { cassetteDir: tempDir } });
    const client = clientFor(server);

    const hit = await client.decide(worthRequestFor(WORTH_MAIL.newsletter));
    expect(hit.answers.worth_score).toMatchObject({ score: WORTH_MAIL.newsletter.score });

    const drifted = worthRequestFor({
      ...WORTH_MAIL.newsletter,
      content: "A body nobody recorded.",
    });
    await expect(client.decide(drifted)).rejects.toThrow(
      /HTTP 422.*no recorded decision for sha256:/,
    );
    expect(JSON.stringify(server.calls.at(-1)!.reply)).toContain("canonicalRequest");
  });

  test("refuseWith opens and closes an outage", async () => {
    server = await startDecisionServer({ policy: () => worthAnswersFor(WORTH_MAIL.friend) });
    const client = clientFor(server);
    server.refuseWith(529);
    await expect(client.decide(worthRequestFor(WORTH_MAIL.friend))).rejects.toThrow(/HTTP 529/);
    server.refuseWith(null);
    await expect(client.decide(worthRequestFor(WORTH_MAIL.friend))).resolves.toMatchObject({
      model: server.modelId,
    });
  });

  test("a policy may refuse one request with a provider status", async () => {
    server = await startDecisionServer({ policy: () => ({ httpError: 401, message: "bad key" }) });
    await expect(clientFor(server).decide(worthRequestFor(WORTH_MAIL.promotion))).rejects.toThrow(
      /HTTP 401/,
    );
  });

  test("a request without a bearer credential is refused", async () => {
    server = await startDecisionServer({ policy: () => worthAnswersFor(WORTH_MAIL.friend) });
    const res = await fetch(server.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: server.modelId, ...worthRequestFor(WORTH_MAIL.friend) }),
    });
    expect(res.status).toBe(401);
  });
});
