// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { execFile } from "node:child_process";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { writeIntegrationCredentials } from "@omnesis/agent-integration";
import { registerOpenClawIntegration } from "@omnesis/agent-integration/openclaw";
import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";
import { cleanupExpiredTokens } from "@omnesis/gateway/src/data/repositories/TokenRepository.js";
import { WatchDefinitionStore } from "@omnesis/gateway/src/watch/definitions.js";
import { openEncryptedSqlite } from "@omnesis/gateway/src/sqlite-encryption.js";
import {
  createSubscription,
  fireSubscription,
  resolveSubscriptionApproval,
} from "@omnesis/gateway/src/subscriptions/store-mutations.js";
import { makeCommand, websocketAuthProtocol } from "@omnesis/core";
import Database from "better-sqlite3";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createFakeOpenClawHost } from "../../../../scripts/test-fixtures/openclaw-host-fixture.mjs";
import { waitForMessageMatching, waitForOpen } from "./helpers.js";
import {
  authorizeMcpClient,
  beginMcpAuthorization,
  clientFor,
  loginPortal,
  portalJson,
  revokeAccess,
  scrapeOAuthUserCode,
  transportFor,
  updateAccessGrant,
  type AuthorizedMcpClient,
  type PendingMcpAuthorization,
} from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

const QUESTION = "When is the Halden Press order due to arrive?";
const RELEASED_ANSWER =
  "The Halden Press order is booked for delivery on Thursday 14 May.\n" +
  "The courier is Ridgeway Logistics.\n" +
  "Someone at Halden Press is expecting the pallet at the loading bay.";
const execFileAsync = promisify(execFile);

describe("privacy-brokered MCP OAuth — spawned replay gateway", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "default",
      agentBackend: "replay",
      extraInference: { assignments: { "privacy-reviewer": "replay" } },
    });
    await harness.start();
    // These answer cassettes cite synthetic Gmail messages through the real
    // citation tool, which resolves each one from the corpus.
    const gmailSources = harness.getSourceIds().filter((id) => id.startsWith("gmail:"));
    expect(gmailSources).not.toHaveLength(0);
    for (const id of gmailSources) await harness.triggerSyncAndWait(id, 60_000);
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("authorizes an Answer-only principal with DCR, PKCE, and Portal short-code approval", async () => {
    const authorized = await oauthClient({
      principalName: "Privacy-reviewed delivery assistant",
      grantName: "Default privacy-reviewed answers",
      credentialLabel: "Fictional answer desktop",
      capabilities: ["answer"],
    });
    try {
      expect(authorized.provider.authorizationUrl?.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      expect(authorized.provider.savedClientInformation?.client_id).toMatch(/^omn_oc_/);
      expect(authorized.provider.savedTokens).toMatchObject({
        access_token: expect.stringMatching(/^omn_oat_/),
        refresh_token: expect.stringMatching(/^omn_ort_/),
      });
      expect((await authorized.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "ask_omnesis",
        "get_answer_status",
      ]);

      const released = await askReleased(authorized, "short_code");
      const status = await authorized.client.callTool({
        name: "get_answer_status",
        arguments: { taskId: released.taskId },
      });
      expect(status.structuredContent).toMatchObject({
        status: "released_with_reductions",
        answer: RELEASED_ANSWER,
        taskId: released.taskId,
      });
      // The draft cited one message through the agent's real citation tool,
      // resolved from the synthetic corpus. A generic MCP client receives the
      // reviewed citation unasked, in the structured result and in the text.
      const citations = (status.structuredContent as { citations?: Array<Record<string, unknown>> })
        .citations;
      expect(citations).toEqual([
        {
          documentId: expect.any(String),
          sourceType: "gmail",
          title: "Q3 logistics recap",
          timestamp: expect.any(String),
          sourceUrl: expect.stringMatching(/^https:\/\/mail\.google\.com\//),
        },
      ]);
      expect((status.content as Array<{ text?: string }>)[0]?.text).toContain(
        "Sources:\n1. Q3 logistics recap · gmail",
      );

      const db = new Database(harness.getDbPath(), { readonly: true });
      try {
        expect(
          db
            .prepare("SELECT endpoint FROM answer_egress_events WHERE task_id = ?")
            .all(released.taskId),
        ).toEqual([{ endpoint: "/mcp" }]);
        const audit = db
          .prepare<[string], { detail: string }>(
            `SELECT detail FROM access_audit_events
             WHERE event_type = 'mcp-tool-invoked' AND credential_id = ?
             ORDER BY occurred_at, id`,
          )
          .all(authorized.credentialId)
          .map((row) => JSON.parse(row.detail) as Record<string, unknown>);
        expect(audit).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              capability: "answer",
              tool: "ask_omnesis",
              outcome: "ok",
              sourceMode: "all",
            }),
            expect.objectContaining({
              capability: "answer",
              tool: "get_answer_status",
              outcome: "ok",
              sourceMode: "all",
            }),
          ]),
        );
      } finally {
        db.close();
      }
    } finally {
      await closeAuthorized(authorized);
    }
  }, 60_000);

  test("releases through a named policy revision and makes unreviewed release explicit", async () => {
    const portal = await loginPortal(gateway());
    const named = await portalJson<{
      familyId: string;
      familyName: string;
      familyVersion: number;
      revision: string;
    }>(harness.gatewayUrl, portal, "/admin/privacy/policies", {
      name: "Fictional delivery policy",
      templateId: "guarded",
    });
    const reviewed = await oauthClient({
      principalName: "Named-policy delivery assistant",
      grantName: "Named reviewed answers",
      credentialLabel: "Fictional named-policy desktop",
      capabilities: ["answer"],
      rules: [
        {
          capability: "answer",
          sources: { mode: "all", sourceIds: [] },
          release: { mode: "reviewed", policyFamilyId: named.familyId },
        },
      ],
    });
    const unreviewed = await oauthClient({
      principalName: "Explicit release assistant",
      grantName: "Explicit unreviewed answers",
      credentialLabel: "Fictional unreviewed desktop",
      capabilities: ["answer"],
      rules: [
        {
          capability: "answer",
          sources: { mode: "all", sourceIds: [] },
          release: { mode: "unreviewed" },
        },
      ],
    });
    try {
      const reviewedResponse = await reviewed.client.callTool({
        name: "ask_omnesis",
        arguments: {
          question: QUESTION,
          requestId: `mcp_answer_named_policy_${randomUUID()}`,
          workflowName: "Fictional reviewed delivery desk",
          workflowPurpose: "Apply the selected named privacy policy to delivery status.",
        },
      });
      expect(reviewedResponse.isError).not.toBe(true);
      expect(reviewedResponse.structuredContent).toMatchObject({
        status: "released_with_reductions",
        answer: expect.any(String),
      });
      const reviewedTaskId = (reviewedResponse.structuredContent as { taskId: string }).taskId;
      const raw = await unreviewed.client.callTool({
        name: "ask_omnesis",
        arguments: {
          question: QUESTION,
          requestId: `mcp_answer_unreviewed_${randomUUID()}`,
          workflowName: "Fictional delivery desk",
          workflowPurpose: "Return delivery status without a privacy review.",
        },
      });
      expect(raw.isError).not.toBe(true);
      expect(raw.structuredContent).toMatchObject({
        status: "released",
        answer: expect.any(String),
      });
      const rawTaskId = (raw.structuredContent as { taskId: string }).taskId;

      const db = new Database(harness.getDbPath(), { readonly: true });
      try {
        expect(answerRule(db, reviewed.grantId)).toEqual({
          sourceMode: "all",
          sourceIds: [],
          releaseMode: "reviewed",
          policyFamilyId: named.familyId,
        });
        expect(answerRule(db, unreviewed.grantId)).toEqual({
          sourceMode: "all",
          sourceIds: [],
          releaseMode: "unreviewed",
          policyFamilyId: null,
        });
        expect(answerTaskPolicy(db, reviewedTaskId)).toBe(named.revision);
        expect(answerTaskPolicy(db, rawTaskId)).toMatch(/^unreviewed:/);
        for (const authorization of [reviewed, unreviewed]) {
          expect(answerInvocationAudit(db, authorization)).toEqual({
            capability: "answer",
            tool: "ask_omnesis",
            outcome: "ok",
            sourceMode: "all",
          });
        }
      } finally {
        db.close();
      }
    } finally {
      await Promise.all([closeAuthorized(reviewed), closeAuthorized(unreviewed)]);
    }
  }, 90_000);

  test("fences an in-flight Answer when its grant revision changes before egress", async () => {
    const authorized = await oauthClient({
      principalName: "Revision-fenced answer assistant",
      grantName: "Revision-fenced Answer access",
      credentialLabel: "Fictional revision-race client",
      capabilities: ["answer"],
      rules: [
        {
          capability: "answer",
          sources: { mode: "all", sourceIds: [] },
          release: { mode: "unreviewed" },
        },
      ],
    });
    const requestId = `mcp_answer_revision_fence_${randomUUID()}`;
    try {
      const invocation = authorized.client.callTool({
        name: "ask_omnesis",
        arguments: {
          question: QUESTION,
          requestId,
          workflowName: "Fictional revision race",
          workflowPurpose: "Prove stale delegated authority cannot release an answer.",
        },
      });
      const taskId = await waitForAnswerTask(harness.getDbPath(), requestId);
      await updateAccessGrant(
        harness.gatewayUrl,
        authorized.portal,
        authorized.grantId,
        authorized.grantRevision,
        [
          {
            capability: "answer",
            sources: { mode: "allowlist", sourceIds: ["gmail:john.smith@example.com"] },
            release: { mode: "unreviewed" },
          },
        ],
      );

      const result = await invocation;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(RELEASED_ANSWER);
      const db = new Database(harness.getDbPath(), { readonly: true });
      try {
        expect(
          db
            .prepare("SELECT COUNT(*) AS count FROM answer_egress_events WHERE task_id = ?")
            .get(taskId),
        ).toEqual({ count: 0 });
        expect(
          db
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM access_audit_events
                WHERE grant_id = ? AND event_type = 'mcp-tool-invoked'
                  AND json_extract(detail, '$.tool') = 'ask_omnesis'
                  AND json_extract(detail, '$.outcome') = 'ok'`,
            )
            .get(authorized.grantId),
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    } finally {
      await closeAuthorized(authorized);
    }
  }, 60_000);

  test("reuses an authenticated Portal session inside the OAuth popup", async () => {
    const authorized = await oauthClient({
      principalName: "Authenticated popup assistant",
      grantName: "Popup-approved Answer access",
      credentialLabel: "Fictional browser-capable client",
      capabilities: ["answer"],
      approval: "authenticated-popup",
    });
    try {
      expect((await authorized.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "ask_omnesis",
        "get_answer_status",
      ]);
      await askReleased(authorized, "popup");
    } finally {
      await closeAuthorized(authorized);
    }
  }, 60_000);

  test("redirects denial without issuing tokens", async () => {
    const pending = await beginMcpAuthorization(gateway());
    try {
      const consent = await fetch(pending.consentUrl);
      expect(consent.status).toBe(200);
      const userCode = scrapeOAuthUserCode(await consent.text());
      const portal = await loginPortal(gateway());
      const lookup = await portalJson<{ request: { approvalId: string } }>(
        harness.gatewayUrl,
        portal,
        "/portal/api/access/authorizations/lookup",
        { code: userCode },
      );
      await portalJson(
        harness.gatewayUrl,
        portal,
        `/portal/api/access/authorizations/${encodeURIComponent(lookup.request.approvalId)}/decision`,
        { decision: "deny" },
      );
      const completed = await completePending(pending);
      expect(completed.status).toBe(303);
      const callback = new URL(requiredHeader(completed, "location"));
      expect(callback.searchParams.get("error")).toBe("access_denied");
      expect(callback.searchParams.get("state")).toBe(pending.provider.stateValue);
      expect(pending.provider.savedTokens).toBeUndefined();
    } finally {
      await closePending(pending);
    }
  }, 30_000);

  test("refreshes an expired access token after restart and expires a pending authorization", async () => {
    const authorized = await oauthClient({
      principalName: "Restart-safe assistant",
      grantName: "Restart-safe Answer access",
      credentialLabel: "Fictional persistent client",
      capabilities: ["answer"],
    });
    const pendingExpiry = await beginMcpAuthorization(gateway());
    const oldAccessToken = authorized.provider.savedTokens?.access_token;
    const refreshToken = authorized.provider.savedTokens?.refresh_token;
    if (!oldAccessToken || !refreshToken || !pendingExpiry.provider.savedClientInformation) {
      throw new Error("OAuth setup omitted material needed for the restart test.");
    }
    await closeAuthorized(authorized);
    await closePending(pendingExpiry);

    await harness.restartGateway(() => {
      const db = new Database(harness.getDbPath());
      try {
        db.prepare(
          "UPDATE oauth_access_tokens SET expires_at = 0 WHERE credential_id = ? AND revoked_at IS NULL",
        ).run(authorized.credentialId);
        db.prepare(
          "UPDATE oauth_authorization_requests SET expires_at = 0 WHERE client_id = ? AND status = 'pending'",
        ).run(pendingExpiry.provider.savedClientInformation!.client_id);
      } finally {
        db.close();
      }
    });

    const expired = await completePending(pendingExpiry);
    expect(expired.status).toBe(410);

    const transport = transportFor(harness.gatewayUrl, authorized.provider);
    const client = clientFor("omnesis-oauth-restart-refresh");
    try {
      await client.connect(transport);
      expect(authorized.provider.savedTokens?.access_token).toMatch(/^omn_oat_/);
      expect(authorized.provider.savedTokens?.access_token).not.toBe(oldAccessToken);
      expect(authorized.provider.savedTokens?.refresh_token).toMatch(/^omn_ort_/);
      expect(authorized.provider.savedTokens?.refresh_token).not.toBe(refreshToken);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "ask_omnesis",
        "get_answer_status",
      ]);
    } finally {
      await Promise.allSettled([client.close(), transport.close()]);
    }
  }, 60_000);

  test("keeps two credentials on one principal and grant independently revocable", async () => {
    const first = await oauthClient({
      principalName: "Shared answer principal",
      grantName: "Shared privacy-reviewed grant",
      credentialLabel: "Fictional workstation one",
      capabilities: ["answer"],
    });
    const second = await oauthClient({
      principalName: "Shared answer principal",
      grantName: "Shared privacy-reviewed grant",
      credentialLabel: "Fictional workstation two",
      capabilities: ["answer"],
      existingGrantId: first.grantId,
    });
    try {
      expect(second.principalId).toBe(first.principalId);
      expect(second.grantId).toBe(first.grantId);
      expect(second.credentialId).not.toBe(first.credentialId);
      await revokeAccess(harness.gatewayUrl, first.portal, {
        kind: "credential",
        id: first.credentialId,
      });
      await expect(
        first.client.listTools(undefined, { cacheMode: "refresh" }),
      ).rejects.toBeDefined();
      expect(
        (await second.client.listTools(undefined, { cacheMode: "refresh" })).tools,
      ).toHaveLength(2);
    } finally {
      await Promise.all([closeAuthorized(first), closeAuthorized(second)]);
    }
  }, 60_000);

  test("binds an OAuth principal to an operational device and wakes it with task identity only", async () => {
    const pendingPairing = await harness.gatewayJson<{ pairingCode: string }>(
      "/admin/devices/pair",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Fictional native MCP integration",
          kind: "agent",
          scopes: ["subscriptions:receive"],
        }),
      },
    );
    const paired = await harness.gatewayJson<{
      device: { id: string };
      credentials: {
        management: { token: string };
        delivery: { token: string };
      };
    }>("/devices/pair", {
      method: "POST",
      body: JSON.stringify({
        pairingCode: pendingPairing.pairingCode,
        agentIntegration: { harness: "openclaw" },
        capabilities: {
          suggestedName: "Fictional native MCP integration",
          agentIntegration: {
            harness: "openclaw",
            deliveryProtocolMin: 3,
            deliveryProtocolMax: 4,
            maxConcurrentRuns: 1,
            watchPrivacyPolicyVersion: 1,
          },
        },
      }),
    });
    const authorized = await oauthClient({
      principalName: "Fictional native Answer agent",
      grantName: "Native privacy-reviewed access",
      credentialLabel: "Fictional OpenClaw installation",
      capabilities: ["answer"],
      executionBinding: { deviceToken: paired.credentials.management.token, harness: "openclaw" },
    });
    const bindingDb = new Database(harness.getDbPath(), { readonly: true });
    try {
      expect(
        bindingDb
          .prepare("SELECT execution_device_id FROM principal_credentials WHERE id = ?")
          .get(authorized.credentialId),
      ).toEqual({ execution_device_id: paired.device.id });
    } finally {
      bindingDb.close();
    }

    const wsUrl = new URL(harness.gatewayUrl);
    wsUrl.protocol = "wss:";
    wsUrl.pathname = "/device/ws";
    const ws = new WebSocket(wsUrl, websocketAuthProtocol(paired.credentials.delivery.token), {
      rejectUnauthorized: false,
    });
    await waitForOpen(ws as never);
    const hello = makeCommand("hello", {
      protocolVersion: 1,
      capabilities: {
        hostname: "fictional-openclaw",
        platform: "test",
        agentIntegration: {
          harness: "openclaw",
          deliveryProtocolMin: 3,
          deliveryProtocolMax: 4,
          maxConcurrentRuns: 1,
          watchPrivacyPolicyVersion: 1,
        },
      },
    });
    ws.send(JSON.stringify(hello));
    await waitForMessageMatching<{ kind: string; correlationId?: string; ok?: boolean }>(
      ws as never,
      (frame) => frame.kind === "response" && frame.correlationId === hello.id && frame.ok === true,
    );

    try {
      const immediate = await authorized.client.callTool({
        name: "ask_omnesis",
        arguments: {
          question: QUESTION,
          requestId: `native_release_${randomUUID()}`,
          approval: "never",
        },
      });
      expect(immediate.structuredContent).toMatchObject({ status: "released_with_reductions" });

      const held = await authorized.client.callTool({
        name: "ask_omnesis",
        arguments: {
          question: "What is the Northstar Club member reference?",
          requestId: `native_hold_${randomUUID()}`,
        },
        _meta: { "dev.omnesis/nativeConversationId": "native_fictional_e2e" },
      });
      expect(held.structuredContent).toMatchObject({ status: "approval_required" });
      expect(JSON.stringify(held)).not.toContain("NS-4827-ALPHA");
      const approval = held.structuredContent as { approvalId: string; taskId: string };

      const preparePromise = waitForMessageMatching<{
        kind: "command";
        id: string;
        type: "answer-completion.prepare";
        payload: {
          deliveryId: string;
          taskId: string;
          nativeConversationId: string;
        };
      }>(
        ws as never,
        (frame) => frame.kind === "command" && frame.type === "answer-completion.prepare",
        30_000,
      );
      await harness.gatewayJson(
        `/admin/privacy/approvals/${encodeURIComponent(approval.approvalId)}/approve`,
        { method: "POST" },
      );
      const prepare = await preparePromise;
      expect(prepare.payload).toMatchObject({
        taskId: approval.taskId,
        nativeConversationId: "native_fictional_e2e",
      });
      expect(JSON.stringify(prepare.payload)).not.toContain("NS-4827-ALPHA");
      expect(prepare.payload).not.toHaveProperty("answer");
      ws.send(
        JSON.stringify({
          kind: "response",
          correlationId: prepare.id,
          ok: true,
          result: { status: "prepared", preparedAt: Date.now(), duplicate: false },
        }),
      );

      const commit = await waitForMessageMatching<{
        kind: "command";
        id: string;
        type: "answer-completion.commit";
        payload: { deliveryId: string };
      }>(
        ws as never,
        (frame) => frame.kind === "command" && frame.type === "answer-completion.commit",
        30_000,
      );
      const released = await authorized.client.callTool({
        name: "get_answer_status",
        arguments: { taskId: approval.taskId },
      });
      expect(released.structuredContent).toMatchObject({
        status: "released",
        taskId: approval.taskId,
        answer: "The Northstar Club member reference is NS-4827-ALPHA.",
      });
      ws.send(
        JSON.stringify({
          kind: "response",
          correlationId: commit.id,
          ok: true,
          result: {
            status: "accepted",
            acceptedAt: Date.now(),
            localRunId: "native-fictional-e2e",
            duplicate: false,
          },
        }),
      );

      const deliveredDeadline = Date.now() + 5_000;
      let delivered = false;
      while (!delivered && Date.now() < deliveredDeadline) {
        const db = new Database(harness.getDbPath(), { readonly: true });
        try {
          delivered =
            (
              db
                .prepare("SELECT status FROM answer_completion_deliveries WHERE id = ?")
                .get(commit.payload.deliveryId) as { status?: string } | undefined
            )?.status === "delivered";
        } finally {
          db.close();
        }
        if (!delivered) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(delivered).toBe(true);
    } finally {
      ws.close();
      await closeAuthorized(authorized);
    }
  }, 120_000);

  test("delivers an approved chat answer to the original OpenClaw session after a plugin restart", async () => {
    const enrolled = await pairedIntegrationAuthorization("openclaw", "approval restart");
    const stateDir = integrationHome("openclaw", enrolled);
    const sessionKey = "agent:main:telegram:dm:fictional-approval";
    const deliveryContext = { channel: "telegram", to: "fictional-recipient" };
    const runs: Array<{ sessionKey: string; message: string; deliver: boolean }> = [];
    let directSends = 0;

    const startPlugin = async () => {
      const host = createFakeOpenClawHost({ runId: "fictional-approved-answer-run" });
      // Substitute only the external host. OAuth, task polling, the delivery
      // WebSocket and both plugin ledgers use their production implementations.
      const api = {
        ...host.api,
        runtime: {
          ...host.api.runtime,
          agent: {
            session: {
              listSessionEntries: () => [
                {
                  sessionKey,
                  entry: {
                    sessionId: "fictional-original-session",
                    delivery: { kind: "external", context: deliveryContext },
                  },
                },
              ],
            },
          },
          subagent: {
            ...host.api.runtime.subagent,
            run: async (input: { sessionKey: string; message: string; deliver: boolean }) => {
              runs.push(input);
              return { runId: "fictional-approved-answer-run" };
            },
          },
          channel: {
            outbound: {
              loadAdapter: async () => ({
                sendText: async () => {
                  directSends += 1;
                },
              }),
            },
          },
        },
      };
      registerOpenClawIntegration(api as never);
      const service = host.services.find((candidate) => candidate.id === "omnesis-integration");
      const registered = host.tools.find((tool) => tool.options.name === "omnesis_answer");
      if (!service || !registered) throw new Error("Production OpenClaw plugin did not register.");
      await service.start({ stateDir, logger: host.logger });
      return { service, registered };
    };

    let running: Awaited<ReturnType<typeof startPlugin>> | undefined;
    try {
      running = await startPlugin();
      const tool = running.registered.factory({
        sessionKey,
        sessionId: "fictional-original-session",
        deliveryContext,
      });
      if (!tool) throw new Error("Production OpenClaw answer tool was unavailable.");
      const held = await tool.execute(
        "fictional-held-chat-call",
        { question: "What is the Northstar Club member reference?", timeoutMs: 60_000 },
        new AbortController().signal,
      );
      expect(held.details).toMatchObject({ ok: true, response: { status: "approval_required" } });
      expect(JSON.stringify(held)).not.toContain("NS-4827-ALPHA");
      expect(runs).toHaveLength(0);
      const { approvalId, taskId } = held.details.response as {
        approvalId: string;
        taskId: string;
      };
      await running.service.stop();
      running = undefined;
      running = await startPlugin();
      await harness.gatewayJson(
        `/admin/privacy/approvals/${encodeURIComponent(approvalId)}/approve`,
        {
          method: "POST",
        },
      );
      await expect.poll(() => runs.length, { timeout: 30_000 }).toBe(1);
      expect(runs[0]).toMatchObject({ sessionKey, deliver: true });
      expect(runs[0]?.message).toContain("NS-4827-ALPHA");
      expect(directSends).toBe(0);
      await expect
        .poll(
          () => {
            const db = new Database(harness.getDbPath(), { readonly: true });
            try {
              return db
                .prepare("SELECT status FROM answer_completion_deliveries WHERE task_id = ?")
                .get(taskId);
            } finally {
              db.close();
            }
          },
          { timeout: 10_000 },
        )
        .toEqual({ status: "delivered" });
    } finally {
      await running?.service.stop();
      rmSync(stateDir, { recursive: true, force: true });
      await closeAuthorized(enrolled.authorization);
    }
  }, 120_000);

  test("resumes a held Watch answer after restart and expiration of its original firing credential", async () => {
    const enrolled = await pairedIntegrationAuthorization("openclaw", "Watch approval restart");
    const stateDir = integrationHome("openclaw", enrolled);
    const suffix = randomUUID();
    const subscriptionId = `sub_${suffix}`;
    const firingId = `sfiring_${suffix}`;
    const runs: Array<{
      sessionKey: string;
      message: string;
      deliver: boolean;
      idempotencyKey: string;
    }> = [];
    const startPlugin = async () => {
      const host = createFakeOpenClawHost({ runId: "fictional-watch-run" });
      registerOpenClawIntegration({
        ...host.api,
        runtime: {
          ...host.api.runtime,
          subagent: {
            ...host.api.runtime.subagent,
            // Only the external host is substituted. The production plugin,
            // firing HTTP authority and completion WebSocket remain real.
            run: async (input: (typeof runs)[number]) => {
              runs.push(input);
              return { runId: `fictional-watch-run-${runs.length}` };
            },
            waitForRun: undefined,
          },
        },
      } as never);
      const service = host.services.find((candidate) => candidate.id === "omnesis-integration");
      const registered = host.tools.find(
        (tool) => tool.options.name === "omnesis_subscription_answer",
      );
      if (!service || !registered) throw new Error("The watch tool did not register.");
      await service.start({ stateDir, logger: host.logger });
      return { service, registered };
    };
    let running: Awaited<ReturnType<typeof startPlugin>> | undefined;
    try {
      // Seed only the synthetic condition's approved firing while the isolated
      // gateway is stopped. Delivery and answering then use the real gateway.
      await harness.restartGateway({
        gatewayMode: "experimental",
        whileStopped: () => {
          const db = new Database(harness.getDbPath());
          db.pragma("foreign_keys = ON");
          try {
            const now = Date.now();
            const watchDb = openEncryptedSqlite(join(harness.getConfigDir(), "watch.db"));
            try {
              new WatchDefinitionStore(watchDb).put({
                id: `wat_${suffix}`,
                name: "fictional-membership-notice",
                status: "active",
                addedAt: new Date(now).toISOString(),
                fromSeq: Number.MAX_SAFE_INTEGER,
                note: null,
                compileRunId: null,
                requestKey: null,
                referenceDigest: null,
                // The test records one firing explicitly; do not replay earlier
                // corpus events into additional wakes during gateway restarts.
                dsl: {
                  watch: {
                    name: "fictional-membership-notice",
                    nl_query: "When a fictional membership notice arrives",
                    firing_policy: "stays_active",
                    nodes: [
                      {
                        id: "mail",
                        type: "source.document_event",
                        filter: { source: "gmail", event: ["created"], documentType: "email" },
                        output_map: { doc_id: "$e.docId" },
                      },
                    ],
                    sink: { input: "mail", output_map: {} },
                    delivery: {
                      kind: "agent-wake",
                      integration: "openclaw",
                      instruction: "Retrieve the membership reference.",
                    },
                  },
                },
              });
            } finally {
              watchDb.close();
            }
            const policy = db
              .prepare<[string], { revision: string }>(
                "SELECT revision FROM privacy_policy_state WHERE family_id = ?",
              )
              .get(DEFAULT_PRIVACY_POLICY_FAMILY_ID);
            if (!policy) throw new Error("Default privacy policy was not initialized.");
            const sourceId = harness.getSourceIds().find((id) => id.startsWith("gmail:"));
            if (!sourceId) throw new Error("The synthetic mail source was not initialized.");
            const documentId = `doc_${suffix}`;
            db.prepare(
              `INSERT INTO documents
              (id, provider_id, source_id, external_id, title, content, content_hash,
               source_created_at, source_updated_at, ingested_at, updated_at)
              VALUES (?, 'gmail', ?, ?, 'Fictional membership notice',
                      'The Northstar Club member reference is NS-4827-ALPHA.', ?, ?, ?, ?, ?)`,
            ).run(
              documentId,
              sourceId,
              suffix,
              suffix,
              ...Array(4).fill(new Date(now).toISOString()),
            );
            expect(
              createSubscription(db, {
                id: subscriptionId,
                approvalId: `sapp_${suffix}`,
                workflowId: `wf_${suffix}`,
                integrationDeviceId: enrolled.paired.device.id,
                ownerId: `device:${enrolled.paired.device.id}`,
                clientRequestId: `request_${suffix}`,
                requestFingerprint: `fingerprint_${suffix}`,
                condition: {
                  kind: "natural-language",
                  description: "when a fictional membership notice arrives",
                },
                reaction: {
                  kind: "agent-workflow",
                  instruction: "Retrieve the membership reference.",
                },
                interpretation: {
                  summary: "A fictional membership notice arrived",
                  pushDetail: "existence",
                },
                compiledPlan: {
                  version: 5,
                  predicate: {
                    kind: "watch-v2",
                    watchId: `wat_${suffix}`,
                    watchName: "fictional-membership-notice",
                    evidence: "documents",
                    authoredBy: "integration",
                  },
                },
                compilerVersion: "synthetic-e2e",
                privacyCategories: ["documents"],
                policyRevision: policy.revision,
                createdAt: now,
                expiresAt: now + 86_400_000,
                approvalExpiresAt: now + 3_600_000,
                createWorkflow: true,
                workflowName: "Fictional membership Watch",
                workflowPurpose: "Read the fictional membership notice.",
                workflowExpiresAt: now + 86_400_000,
              }).outcome,
            ).toBe("created");
            expect(
              resolveSubscriptionApproval(db, {
                approvalId: `sapp_${suffix}`,
                decision: "approve",
                resolvedBy: { kind: "device", deviceId: enrolled.paired.device.id, tokenId: null },
                policyRevision: policy.revision,
                grantId: `sgrant_${suffix}`,
                grantExpiresAt: now + 86_400_000,
                resolvedAt: now,
              }).outcome,
            ).toBe("resolved");
            expect(
              fireSubscription(db, {
                firingId,
                subscriptionId,
                revision: 1,
                indexEventKey: `event_${suffix}`,
                evidenceDocumentIds: [documentId],
                policyRevision: policy.revision,
                firedAt: now,
              }).outcome,
            ).toBe("fired");
          } finally {
            db.close();
          }
        },
      });
      running = await startPlugin();
      await expect.poll(() => runs.length, { timeout: 30_000 }).toBe(1);
      const sessionKey = runs[0]!.sessionKey;
      const tool = running.registered.factory({ sessionKey });
      if (!tool) throw new Error("The watch answer tool was unavailable.");
      const held = await tool.execute(
        "fictional-held-watch-call",
        {
          firingId,
          question: "What is the Northstar Club member reference?",
          timeoutMs: 60_000,
        },
        new AbortController().signal,
      );
      expect(held.details).toMatchObject({ ok: true, response: { status: "approval_required" } });
      expect(JSON.stringify(held)).not.toContain("NS-4827-ALPHA");
      const { approvalId, taskId } = held.details.response as {
        approvalId: string;
        taskId: string;
      };
      // This is the ownership distinction that an ordinary-chat-only test misses.
      const wrongOwner = await enrolled.authorization.client.callTool({
        name: "get_answer_status",
        arguments: { taskId },
      });
      expect(wrongOwner.isError).toBe(true);
      await running.service.stop();
      running = undefined;
      await harness.restartGateway(() => {
        const db = new Database(harness.getDbPath());
        db.pragma("foreign_keys = ON");
        try {
          const expired = db
            .prepare(
              `UPDATE tokens SET expires_at = 0
            WHERE id IN (SELECT token_id FROM subscription_firing_answer_authorities WHERE firing_id = ?)`,
            )
            .run(firingId);
          expect(expired.changes).toBeGreaterThan(0);
          cleanupExpiredTokens(db);
          expect(
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM subscription_firing_answer_authorities WHERE firing_id = ?",
              )
              .get(firingId),
          ).toEqual({ count: 0 });
        } finally {
          db.close();
        }
      });
      running = await startPlugin();
      const grantDb = new Database(harness.getDbPath(), { readonly: true });
      try {
        expect(
          grantDb
            .prepare("SELECT revoked_at FROM subscription_grants WHERE subscription_id = ?")
            .get(subscriptionId),
        ).toEqual({ revoked_at: null });
      } finally {
        grantDb.close();
      }
      await harness.gatewayJson(
        `/admin/privacy/approvals/${encodeURIComponent(approvalId)}/approve`,
        { method: "POST" },
      );
      const completionSnapshot = () => {
        const db = new Database(harness.getDbPath(), { readonly: true });
        try {
          return {
            runs: runs.length,
            completion: db
              .prepare(
                `SELECT c.status, c.last_error, t.policy_revision,
              r.policy_revision AS subscription_policy, d.status AS firing_delivery_status,
              f.status AS firing_status
              FROM answer_completion_deliveries c JOIN answer_tasks t ON t.id = c.task_id
              JOIN subscription_firings f ON f.id = t.subscription_firing_id
              JOIN subscription_revisions r ON r.subscription_id = f.subscription_id AND r.revision = f.revision
              JOIN subscription_deliveries d ON d.firing_id = f.id WHERE t.id = ?`,
              )
              .get(taskId),
          };
        } finally {
          db.close();
        }
      };
      try {
        await expect
          .poll(completionSnapshot, { timeout: 30_000 })
          .toMatchObject({ runs: 2, completion: { status: "delivered", last_error: null } });
      } catch (error) {
        const inbox = new Database(join(stateDir, "omnesis", "integration.sqlite"), {
          readonly: true,
        });
        try {
          const localCompletion = inbox
            .prepare(
              "SELECT state, last_error, start_attempts FROM integration_answer_completion_inbox",
            )
            .all();
          const gatewayErrors = readFileSync(harness.getGatewayLogPath(), "utf8")
            .split("\n")
            .filter((line) => line.includes("answer-completions") || line.includes("Error:"));
          throw new Error(
            `Watch completion diagnostics: ${JSON.stringify({ ...completionSnapshot(), localCompletion, gatewayErrors })}`,
            { cause: error },
          );
        } finally {
          inbox.close();
        }
      }
      expect(runs[1]).toMatchObject({
        sessionKey,
        deliver: false,
        idempotencyKey: expect.stringMatching(/^answer-completion:/),
      });
      expect(runs[1]!.message).toContain("NS-4827-ALPHA");
      await expect
        .poll(
          () => {
            const db = new Database(harness.getDbPath(), { readonly: true });
            try {
              return db
                .prepare("SELECT status FROM answer_completion_deliveries WHERE task_id = ?")
                .get(taskId);
            } finally {
              db.close();
            }
          },
          { timeout: 10_000 },
        )
        .toEqual({ status: "delivered" });
      const db = new Database(harness.getDbPath(), { readonly: true });
      try {
        expect(
          db
            .prepare("SELECT endpoint FROM answer_egress_events WHERE task_id = ? AND endpoint = ?")
            .all(taskId, "/subscriptions/answer-completions/:deliveryId"),
        ).toHaveLength(1);
      } finally {
        db.close();
      }
    } finally {
      await running?.service.stop();
      await fetch(`${harness.gatewayUrl}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${enrolled.paired.credentials.management.token}` },
      }).catch(() => undefined);
      await harness.restartGateway({ gatewayMode: "stable" });
      rmSync(stateDir, { recursive: true, force: true });
      await closeAuthorized(enrolled.authorization);
    }
  }, 180_000);

  test("runs the production OpenClaw and Hermes plugins through OAuth-protected /mcp", async () => {
    const openClaw = await pairedIntegrationAuthorization("openclaw");
    const hermes = await pairedIntegrationAuthorization("hermes");
    const oldOpenClawAccess = openClaw.authorization.provider.savedTokens?.access_token;
    const oldHermesAccess = hermes.authorization.provider.savedTokens?.access_token;
    if (!oldOpenClawAccess || !oldHermesAccess) {
      throw new Error("Plugin OAuth setup omitted its access token.");
    }
    expireAccessCredential(openClaw.authorization.credentialId);
    expireAccessCredential(hermes.authorization.credentialId);

    const openClawHome = integrationHome("openclaw", openClaw);
    const hermesHome = integrationHome("hermes", hermes);
    try {
      const openClawResult = await invokeProductionOpenClaw(openClawHome);
      expect(openClawResult).toMatchObject({
        details: {
          ok: true,
          response: {
            status: "released_with_reductions",
            answer: RELEASED_ANSWER,
          },
        },
      });
      expect(integrationAccessToken(openClawHome)).not.toBe(oldOpenClawAccess);

      const probe = await execFileAsync(
        "python3",
        [resolve(import.meta.dirname, "../../../agent-integration/test/hermes_gateway_probe.py")],
        {
          env: {
            ...process.env,
            HERMES_HOME: hermesHome,
            OMNESIS_HERMES_ADAPTER_PATH: resolve(
              import.meta.dirname,
              "../../../agent-integration/hermes/adapter.py",
            ),
            OMNESIS_HERMES_REAL_MCP: "1",
            OMNESIS_HERMES_QUESTION: QUESTION,
            OMNESIS_HERMES_EXPECTED_ANSWER: RELEASED_ANSWER,
          },
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        },
      );
      expect(JSON.parse(probe.stdout)).toMatchObject({ status: "MCP_OAUTH_OK" });
      expect(integrationAccessToken(hermesHome)).not.toBe(oldHermesAccess);

      const db = new Database(harness.getDbPath(), { readonly: true });
      try {
        for (const credentialId of [
          openClaw.authorization.credentialId,
          hermes.authorization.credentialId,
        ]) {
          const count = (
            db
              .prepare(
                `SELECT COUNT(*) AS count FROM access_audit_events
                 WHERE credential_id = ? AND event_type = 'mcp-tool-invoked'`,
              )
              .get(credentialId) as { count: number }
          ).count;
          expect(count).toBeGreaterThan(0);
        }
      } finally {
        db.close();
      }
    } finally {
      rmSync(openClawHome, { recursive: true, force: true });
      rmSync(hermesHome, { recursive: true, force: true });
      await Promise.all([
        closeAuthorized(openClaw.authorization),
        closeAuthorized(hermes.authorization),
      ]);
    }
  }, 120_000);

  async function pairedIntegrationAuthorization(
    integration: "openclaw" | "hermes",
    scenario = "production plugin",
  ) {
    const deviceName = `Fictional ${integration} ${scenario}`;
    const pendingPairing = await harness.gatewayJson<{ pairingCode: string }>(
      "/admin/devices/pair",
      {
        method: "POST",
        body: JSON.stringify({
          name: deviceName,
          kind: "agent",
          scopes: ["subscriptions:receive"],
        }),
      },
    );
    const paired = await harness.gatewayJson<{
      device: { id: string };
      credentials: {
        management: { token: string };
        delivery: { token: string };
        ingestion: { token: string };
      };
    }>("/devices/pair", {
      method: "POST",
      body: JSON.stringify({
        pairingCode: pendingPairing.pairingCode,
        agentIntegration: { harness: integration },
        capabilities: {
          suggestedName: deviceName,
          agentIntegration: {
            harness: integration,
            deliveryProtocolMin: 3,
            deliveryProtocolMax: 4,
            maxConcurrentRuns: 1,
            watchPrivacyPolicyVersion: 1,
          },
        },
      }),
    });
    const authorization = await oauthClient({
      principalName: `Fictional ${integration} production principal`,
      grantName: `${integration} privacy-reviewed access`,
      credentialLabel: `Fictional ${integration} plugin installation`,
      capabilities: ["answer"],
      executionBinding: {
        deviceToken: paired.credentials.management.token,
        harness: integration,
      },
    });
    return { paired, authorization };
  }

  function integrationHome(
    integration: "openclaw" | "hermes",
    enrolled: Awaited<ReturnType<typeof pairedIntegrationAuthorization>>,
  ): string {
    const home = mkdtempSync(join(tmpdir(), `omnesis-${integration}-production-e2e-`));
    const provider = enrolled.authorization.provider;
    if (!provider.savedClientInformation || !provider.savedTokens) {
      throw new Error("Plugin OAuth setup omitted persisted OAuth state.");
    }
    const caPem = readFileSync(join(harness.getConfigDir(), "tls", "cert.pem"), "utf8");
    const leafFingerprintSha256 = createHash("sha256")
      .update(new X509Certificate(caPem).raw)
      .digest("hex");
    writeIntegrationCredentials(join(home, "omnesis", "integration.json"), {
      gatewayUrl: harness.gatewayUrl,
      deliveryToken: enrolled.paired.credentials.delivery.token,
      ingestionToken: enrolled.paired.credentials.ingestion.token,
      managementToken: enrolled.paired.credentials.management.token,
      oauth: {
        redirectUri: provider.redirectUrl.toString(),
        clientInformation: { ...provider.savedClientInformation },
        tokens: { ...provider.savedTokens },
      },
      tls: { caPem, leafFingerprintSha256 },
      maxConcurrentRuns: 1,
    });
    return home;
  }

  function integrationAccessToken(home: string): string | undefined {
    const credentials = JSON.parse(
      readFileSync(join(home, "omnesis", "integration.json"), "utf8"),
    ) as { oauth?: { tokens?: { access_token?: string } } };
    return credentials.oauth?.tokens?.access_token;
  }

  function expireAccessCredential(credentialId: string): void {
    const db = new Database(harness.getDbPath());
    try {
      db.prepare(
        "UPDATE oauth_access_tokens SET expires_at = 0 WHERE credential_id = ? AND revoked_at IS NULL",
      ).run(credentialId);
    } finally {
      db.close();
    }
  }

  async function invokeProductionOpenClaw(stateDir: string): Promise<unknown> {
    const { api, services, tools, logger } = createFakeOpenClawHost({
      runId: "run-fictional-production-e2e",
    });
    registerOpenClawIntegration(api as never);
    const service = services.find((candidate) => candidate.id === "omnesis-integration");
    const registered = tools.find((tool) => tool.options.name === "omnesis_answer");
    if (!service || !registered) throw new Error("Production OpenClaw plugin did not register.");
    await service.start({ stateDir, logger });
    try {
      const tool = registered.factory({ sessionKey: "agent:main:cron:e2e:run:one" });
      if (!tool) throw new Error("Production OpenClaw answer tool was unavailable.");
      return await tool.execute(
        "fictional-production-tool-call",
        { question: QUESTION, timeoutMs: 60_000 },
        new AbortController().signal,
      );
    } finally {
      await service.stop();
    }
  }

  function gateway() {
    return {
      gatewayUrl: harness.gatewayUrl,
      apiKey: harness.apiKey,
      gatewayLogPath: harness.getGatewayLogPath(),
    };
  }

  function oauthClient(input: Parameters<typeof authorizeMcpClient>[1]) {
    return authorizeMcpClient(gateway(), input);
  }

  async function completePending(pending: PendingMcpAuthorization): Promise<Response> {
    return fetch(
      `${harness.gatewayUrl}/oauth/authorize/complete?request=${encodeURIComponent(pending.requestHandle)}`,
      { redirect: "manual" },
    );
  }
});

async function askReleased(
  authorized: AuthorizedMcpClient,
  suffix: string,
): Promise<{ taskId: string; answer: string }> {
  const response = await authorized.client.callTool({
    name: "ask_omnesis",
    arguments: {
      question: QUESTION,
      requestId: `mcp_answer_${suffix}_${randomUUID()}`,
      workflowName: "Delivery desk",
      workflowPurpose: "Answer courier scheduling questions for open orders.",
    },
  });
  expect(response.isError).not.toBe(true);
  expect(response.structuredContent).toMatchObject({
    status: "released_with_reductions",
    answer: RELEASED_ANSWER,
  });
  expect(JSON.stringify(response)).not.toContain("09:00");
  expect(JSON.stringify(response)).not.toContain("RW-40128");
  expect(JSON.stringify(response)).not.toContain("Maya Reeves");
  return response.structuredContent as { taskId: string; answer: string };
}

function answerRule(db: Database.Database, grantId: string) {
  const row = db
    .prepare<
      [string],
      {
        source_mode: string;
        source_ids: string;
        release_mode: string | null;
        policy_family_id: string | null;
      }
    >(
      `SELECT source_mode, source_ids, release_mode, policy_family_id
       FROM access_grant_capabilities WHERE grant_id = ? AND capability = 'answer'`,
    )
    .get(grantId);
  return row
    ? {
        sourceMode: row.source_mode,
        sourceIds: JSON.parse(row.source_ids) as string[],
        releaseMode: row.release_mode,
        policyFamilyId: row.policy_family_id,
      }
    : undefined;
}

function answerTaskPolicy(db: Database.Database, taskId: string): string | null | undefined {
  return db
    .prepare<[string], { policy_revision: string | null }>(
      "SELECT policy_revision FROM answer_tasks WHERE id = ?",
    )
    .get(taskId)?.policy_revision;
}

function answerInvocationAudit(
  db: Database.Database,
  authorized: AuthorizedMcpClient,
): Record<string, unknown> | undefined {
  const row = db
    .prepare<[string], { detail: string }>(
      `SELECT detail FROM access_audit_events
       WHERE event_type = 'mcp-tool-invoked' AND credential_id = ?
         AND grant_revision = ? AND principal_id = ? AND grant_id = ?
       ORDER BY occurred_at, id LIMIT 1`,
    )
    .get(
      authorized.credentialId,
      authorized.grantRevision,
      authorized.principalId,
      authorized.grantId,
    );
  if (!row) return undefined;
  const { requestId: _requestId, ...detail } = JSON.parse(row.detail) as Record<string, unknown>;
  return detail;
}

async function closeAuthorized(authorized: AuthorizedMcpClient): Promise<void> {
  await Promise.allSettled([authorized.client.close(), authorized.transport.close()]);
}

async function closePending(pending: PendingMcpAuthorization): Promise<void> {
  await Promise.allSettled([pending.client.close(), pending.transport.close()]);
}

async function waitForAnswerTask(dbPath: string, requestId: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const db = new Database(dbPath, { readonly: true });
    try {
      const task = db
        .prepare<[string], { id: string }>(
          "SELECT id FROM answer_tasks WHERE client_request_id = ?",
        )
        .get(requestId);
      if (task) return task.id;
    } finally {
      db.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The synthetic Answer invocation never reached its durable task boundary.");
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw new Error(`OAuth response omitted ${name}.`);
  return value;
}
