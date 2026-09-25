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
      const userCode = (await consent.text()).match(/[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0];
      if (!userCode) throw new Error("Anonymous consent omitted its user code.");
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

  async function pairedIntegrationAuthorization(integration: "openclaw" | "hermes") {
    const pendingPairing = await harness.gatewayJson<{ pairingCode: string }>(
      "/admin/devices/pair",
      {
        method: "POST",
        body: JSON.stringify({
          name: `Fictional ${integration} production plugin`,
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
          suggestedName: `Fictional ${integration} production plugin`,
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
    .prepare<
      [string],
      { policy_revision: string | null }
    >("SELECT policy_revision FROM answer_tasks WHERE id = ?")
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
        .prepare<
          [string],
          { id: string }
        >("SELECT id FROM answer_tasks WHERE client_request_id = ?")
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
