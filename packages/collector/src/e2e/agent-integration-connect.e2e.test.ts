// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";

import { globSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadIntegrationCredentials } from "@omnesis/agent-integration";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createSubscription } from "@omnesis/gateway/src/subscriptions/store-mutations.js";

import { enrollManagedIntegration } from "./managed-integration-enrollment.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

const QUESTION = "When is the Halden Press order due to arrive?";
const RELEASED_ANSWER =
  "The Halden Press order is booked for delivery on Thursday 14 May.\n" +
  "The courier is Ridgeway Logistics.\n" +
  "Someone at Halden Press is expecting the pallet at the loading bay.";
const repositoryRoot = resolve(import.meta.dirname, "../../../..");

describe("managed agent integration enrollment — spawned gateway", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "experimental",
      universe: "default",
      agentBackend: "replay",
      extraInference: { assignments: { "privacy-reviewer": "replay" } },
    });
    await harness.start();
    const health = await harness.gatewayJson<{
      experimental: boolean;
      capabilities: { subscriptions: boolean };
    }>("/health");
    expect(
      health,
      "the managed-integration suite requires subscription support — check the harness environment, not the product",
    ).toMatchObject({ experimental: true, capabilities: { subscriptions: true } });
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("connects, installs, authorizes, and cold-restarts the OpenClaw plugin", async () => {
    await exerciseManagedIntegration("openclaw");
  }, 180_000);

  test("connects, installs, authorizes, and cold-restarts the Hermes adapter", async () => {
    await exerciseManagedIntegration("hermes");
  }, 180_000);

  test("re-running connect on a connected OpenClaw machine keeps its device and its watches", async () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-openclaw-reconnect-e2e-"));
    const cliConfig = mkdtempSync(join(tmpdir(), "omnesis-openclaw-reconnect-cli-e2e-"));
    const fakeBin = mkdtempSync(join(tmpdir(), "omnesis-openclaw-reconnect-bin-e2e-"));
    try {
      prepareHarnessHome("openclaw", home, fakeBin);
      const enroll = () =>
        enrollManagedIntegration({
          harness: "openclaw",
          repositoryRoot,
          gatewayUrl: harness.gatewayUrl,
          portalApiKey: harness.apiKey,
          gatewayDbPath: harness.getDbPath(),
          home,
          fakeBin,
          cliConfigDir: cliConfig,
          // The portal card's code: unbound, so only the machine's own saved
          // credential can land it on the existing device.
          createPairingCode: async () =>
            (
              await harness.gatewayJson<{ pairingCode: string }>("/admin/devices/pair", {
                method: "POST",
                body: JSON.stringify({ kind: "agent" }),
              })
            ).pairingCode,
        });

      const credentialsPath = join(home, "omnesis", "integration.json");
      const first = await enroll();
      const oldDelivery = loadIntegrationCredentials(credentialsPath).deliveryToken;
      const deviceId = accessIdentity(first.authorizationRequestId).executionDeviceId;
      const tokensBefore = tokenIds(deviceId);
      await harness.restartGateway(() => {
        withDb(false, (db) => {
          expect(createSubscription(db, fictionalSubscription(deviceId)).outcome).toBe("created");
        });
      });
      const watchBefore = subscriptionRow();
      const devicesBefore = agentDeviceCount();

      const second = await enroll();

      expect(second.connectOutput).toMatch(/Reconnected/u);
      expect(accessIdentity(second.authorizationRequestId).executionDeviceId).toBe(deviceId);
      expect(agentDeviceCount()).toBe(devicesBefore);
      const tokensAfter = tokenIds(deviceId);
      expect(tokensAfter).toHaveLength(3);
      expect(tokensAfter.filter((id) => tokensBefore.includes(id))).toEqual([]);
      expect(subscriptionRow()).toEqual(watchBefore);
      expect(watchBefore).toMatchObject({ integration_device_id: deviceId });
      // The machine now holds the new credentials, and the old ones are dead.
      const whoami = (token: string) =>
        fetch(`${harness.gatewayUrl}/whoami`, { headers: { Authorization: `Bearer ${token}` } });
      const newDelivery = loadIntegrationCredentials(credentialsPath).deliveryToken;
      expect(newDelivery).not.toBe(oldDelivery);
      // A delivery credential is known to the gateway but not allowed to read
      // /whoami (403); an unknown credential is not authenticated at all (401).
      expect((await whoami(newDelivery)).status).toBe(403);
      expect((await whoami(oldDelivery)).status).toBe(401);

      // A machine that kept its identity but lost its credentials cannot take
      // the device over with an unbound code, and is told what to choose.
      rmSync(credentialsPath, { force: true });
      const refused = await enroll().then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(refused).toMatch(/choose "Reconnect"/u);
      expect(agentDeviceCount()).toBe(devicesBefore);
      expect(tokenIds(deviceId)).toEqual(tokensAfter);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cliConfig, { recursive: true, force: true });
      rmSync(fakeBin, { recursive: true, force: true });
    }
  }, 300_000);

  function tokenIds(deviceId: string): string[] {
    return withDb(true, (db) =>
      (
        db.prepare("SELECT id FROM tokens WHERE device_id = ?").all(deviceId) as Array<{
          id: string;
        }>
      ).map((row) => row.id),
    );
  }

  function agentDeviceCount(): number {
    return withDb(
      true,
      (db) =>
        (
          db.prepare("SELECT COUNT(*) AS count FROM devices WHERE kind = 'agent'").get() as {
            count: number;
          }
        ).count,
    );
  }

  function subscriptionRow() {
    return withDb(true, (db) =>
      db
        .prepare("SELECT integration_device_id, status FROM subscriptions WHERE id = ?")
        .get("sub_fictional_reconnect_e2e"),
    );
  }

  function fictionalSubscription(deviceId: string): Parameters<typeof createSubscription>[1] {
    const now = Date.now();
    return {
      id: "sub_fictional_reconnect_e2e",
      approvalId: "sapp_fictional_reconnect_e2e",
      workflowId: "wf_fictional_reconnect_e2e",
      integrationDeviceId: deviceId,
      ownerId: `device:${deviceId}`,
      clientRequestId: "request-fictional-reconnect-e2e",
      requestFingerprint: "fingerprint-fictional-reconnect-e2e",
      condition: { kind: "natural-language", description: "when a fictional memo is created" },
      reaction: { kind: "agent-workflow", instruction: "Summarize the fictional memo." },
      interpretation: { summary: "A fictional memo is created", pushDetail: "existence" },
      compiledPlan: {
        version: 1,
        events: ["created"],
        predicate: { kind: "title-equals", value: "Fictional memo" },
      },
      compilerVersion: "test-v1",
      privacyCategories: ["documents"],
      policyRevision: "policy-a",
      createdAt: now,
      expiresAt: now + 86_400_000,
      approvalExpiresAt: now + 3_600_000,
      workflowName: "Fictional reconnect workflow",
      workflowPurpose: "Summarize the fictional memo.",
      createWorkflow: true,
      workflowExpiresAt: now + 86_400_000,
    };
  }

  async function exerciseManagedIntegration(harnessName: "openclaw" | "hermes") {
    const home = mkdtempSync(join(tmpdir(), `omnesis-${harnessName}-connect-e2e-`));
    const cliConfig = mkdtempSync(join(tmpdir(), `omnesis-${harnessName}-cli-e2e-`));
    const fakeBin = mkdtempSync(join(tmpdir(), `omnesis-${harnessName}-bin-e2e-`));
    let primaryError: unknown;
    try {
      prepareHarnessHome(harnessName, home, fakeBin);
      const enrollment = await enrollManagedIntegration({
        harness: harnessName,
        repositoryRoot,
        gatewayUrl: harness.gatewayUrl,
        portalApiKey: harness.apiKey,
        gatewayDbPath: harness.getDbPath(),
        home,
        fakeBin,
        cliConfigDir: cliConfig,
        createPairingCode: async () => {
          const pairing = await harness.gatewayJson<{ pairingCode: string }>(
            "/admin/devices/pair",
            {
              method: "POST",
              body: JSON.stringify({
                name: `Fictional ${harnessName} managed integration`,
                kind: "agent",
                scopes: ["subscriptions:receive"],
              }),
            },
          );
          return pairing.pairingCode;
        },
      });

      const credentialsPath = join(home, "omnesis", "integration.json");
      const credentials = loadIntegrationCredentials(credentialsPath);
      expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
      expect(credentials.oauth.tokens).toMatchObject({
        access_token: expect.stringMatching(/^omn_oat_/u),
        refresh_token: expect.stringMatching(/^omn_ort_/u),
      });
      const identity = accessIdentity(enrollment.authorizationRequestId);
      expect(identity).toMatchObject({
        executionDeviceId: expect.any(String),
        credentialExecutionDeviceId: expect.any(String),
        credentialId: expect.any(String),
        principalId: expect.any(String),
        grantId: expect.any(String),
      });
      expect(identity.credentialExecutionDeviceId).toBe(identity.executionDeviceId);
      expect(installedArtifact(harnessName, home)).toBe(true);

      if (harnessName === "openclaw") {
        expect((await probeOpenClawPlugin(home)).tools).toEqual([
          "omnesis_answer",
          "omnesis_subscriptions",
        ]);
      }

      const firstResult = await invokeColdPlugin(harnessName, home);
      expect(firstResult).toMatchObject({ answer: RELEASED_ANSWER });
      const oldAccessToken = String(credentials.oauth.tokens.access_token);
      const countsBefore = lifecycleCounts();

      await harness.restartGateway(() => expireAccessWhileGatewayStopped(identity.credentialId));
      const secondResult = await invokeColdPlugin(harnessName, home);
      expect(secondResult).toMatchObject({ answer: RELEASED_ANSWER });
      expect(loadIntegrationCredentials(credentialsPath).oauth.tokens.access_token).not.toBe(
        oldAccessToken,
      );
      expect(accessIdentity(enrollment.authorizationRequestId)).toEqual(identity);
      expect(lifecycleCounts()).toEqual(countsBefore);
      expect(toolAuditCount(identity.credentialId)).toBeGreaterThanOrEqual(2);
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        rmSync(home, { recursive: true, force: true });
        rmSync(cliConfig, { recursive: true, force: true });
        rmSync(fakeBin, { recursive: true, force: true });
      } catch (cleanupError) {
        primaryError ??= cleanupError;
      }
    }
    if (primaryError) throw primaryError;
  }

  function prepareHarnessHome(
    harnessName: "openclaw" | "hermes",
    home: string,
    fakeBin: string,
  ): void {
    for (const opener of ["open", "xdg-open"]) {
      writeFileSync(join(fakeBin, opener), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    if (harnessName === "openclaw") {
      writeFileSync(join(home, "openclaw.json"), "{}\n");
      return;
    }
    writeFileSync(join(home, "config.yaml"), "display:\n  background_process_notifications: all\n");
    writeFileSync(
      join(fakeBin, "hermes"),
      '#!/bin/sh\n[ "$1" = plugins ] && [ "$2" = enable ] && [ "$3" = --no-allow-tool-override ] && [ "$4" = omnesis-integration ] || exit 64\ntouch "$HERMES_HOME/.omnesis-hermes-enabled-e2e"\n',
      { mode: 0o755 },
    );
  }

  function accessIdentity(requestId: string) {
    return withDb(true, (db) => {
      const row = db
        .prepare(
          `SELECT ar.execution_device_id AS executionDeviceId,
                  pc.execution_device_id AS credentialExecutionDeviceId,
                  pc.id AS credentialId, ag.principal_id AS principalId, pc.grant_id AS grantId
           FROM oauth_authorization_requests ar
           JOIN principal_credentials pc ON pc.id = ar.credential_id
           JOIN access_grants ag ON ag.id = pc.grant_id
           WHERE ar.id = ?`,
        )
        .get(requestId) as
        | {
            executionDeviceId: string;
            credentialExecutionDeviceId: string;
            credentialId: string;
            principalId: string;
            grantId: string;
          }
        | undefined;
      if (!row) throw new Error("authorization identity was not persisted");
      return row;
    });
  }

  function lifecycleCounts() {
    return withDb(true, (db) => ({
      devices: (
        db.prepare("SELECT COUNT(*) AS count FROM devices WHERE kind = 'agent'").get() as {
          count: number;
        }
      ).count,
      requests: (
        db.prepare("SELECT COUNT(*) AS count FROM oauth_authorization_requests").get() as {
          count: number;
        }
      ).count,
      credentials: (
        db.prepare("SELECT COUNT(*) AS count FROM principal_credentials").get() as { count: number }
      ).count,
    }));
  }

  function expireAccessWhileGatewayStopped(credentialId: string): void {
    withDb(false, (db) => {
      db.prepare(
        "UPDATE oauth_access_tokens SET expires_at = 0 WHERE credential_id = ? AND revoked_at IS NULL",
      ).run(credentialId);
    });
  }

  function toolAuditCount(credentialId: string): number {
    return withDb(
      true,
      (db) =>
        (
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM access_audit_events
             WHERE credential_id = ? AND event_type = 'mcp-tool-invoked'`,
            )
            .get(credentialId) as { count: number }
        ).count,
    );
  }

  async function invokeColdPlugin(harnessName: "openclaw" | "hermes", home: string) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    if (harnessName === "openclaw") {
      const result = await run(
        process.execPath,
        [resolve(repositoryRoot, "packages/agent-integration/test/openclaw_mcp_probe.mjs")],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            OMNESIS_OPENCLAW_ENTRY_PATH: openClawEntry(home),
            OMNESIS_OPENCLAW_STATE_DIR: home,
            OMNESIS_OPENCLAW_QUESTION: QUESTION,
          },
          timeout: 90_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const parsed = JSON.parse(result.stdout) as { details?: { response?: unknown } };
      return parsed.details?.response as { answer?: string };
    }
    const result = await run(
      "python3",
      [resolve(repositoryRoot, "packages/agent-integration/test/hermes_gateway_probe.py")],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          HERMES_HOME: home,
          OMNESIS_HERMES_ADAPTER_PATH: join(home, "plugins", "omnesis-integration", "adapter.py"),
          OMNESIS_HERMES_REAL_MCP: "1",
          OMNESIS_HERMES_QUESTION: QUESTION,
          OMNESIS_HERMES_EXPECTED_ANSWER: RELEASED_ANSWER,
        },
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return (JSON.parse(result.stdout) as { answer: { answer: string } }).answer;
  }

  async function probeOpenClawPlugin(home: string): Promise<{ tools: string[] }> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const result = await promisify(execFile)(
      process.execPath,
      [resolve(repositoryRoot, "packages/agent-integration/test/openclaw_plugin_probe.mjs")],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          OMNESIS_OPENCLAW_ENTRY_PATH: openClawEntry(home),
          OMNESIS_OPENCLAW_STATE_DIR: home,
        },
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return JSON.parse(result.stdout) as { tools: string[] };
  }

  function installedArtifact(harnessName: "openclaw" | "hermes", home: string): boolean {
    const paths =
      harnessName === "openclaw"
        ? [openClawEntry(home)]
        : [
            join(home, "plugins", "omnesis-integration", "adapter.py"),
            join(home, ".omnesis-hermes-enabled-e2e"),
          ];
    try {
      return paths.every((path) => statSync(path).isFile());
    } catch {
      return false;
    }
  }

  function openClawEntry(home: string): string {
    const matches = globSync(
      "npm/projects/*/node_modules/@omnesis/agent-integration/openclaw-entry.mjs",
      { cwd: home },
    );
    if (matches.length !== 1) {
      throw new Error(`expected one managed OpenClaw Omnesis entry, found ${matches.length}`);
    }
    return join(home, matches[0]!);
  }

  function withDb<T>(readonly: boolean, operation: (db: Database.Database) => T): T {
    const db = new Database(harness.getDbPath(), { readonly });
    try {
      return operation(db);
    } finally {
      db.close();
    }
  }
});
