// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The managed OpenClaw integration on an ordinary gateway.
 *
 * The sibling suite selects the harness's experimental gateway mode. This one
 * deliberately selects stable mode, which is the whole point: a default
 * gateway is the one almost every operator has, and connecting a harness to it
 * has to produce a working integration rather than a half-installed one.
 *
 * Working means three separate things, and they are what this file pins:
 *
 *   - the ceremony completes — pairing code, TLS trust, OAuth approval, plugin
 *     install — against a gateway with no Watch runtime behind it;
 *   - what got installed matches what the gateway can do: the skill describes
 *     no Watch tools and the started plugin offers none, while transcript
 *     ingestion and Answer through `/mcp` work exactly as before; and
 *   - the OAuth ticket cannot quietly run out. The plugin renews it on start
 *     when it is near its end, recovers it headlessly once it has expired, and
 *     stops being able to the moment the operator revokes the grant — at which
 *     point the gateway says so on the device itself.
 */

import "./synth-env.js";

import { execFile } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  spawnConnect,
  terminateConnect,
  waitForExit,
  type SpawnedConnect,
} from "./connect-process.js";
import {
  accessOverview,
  decideOAuthAuthorization,
  loginPortal,
  newAnswerPrincipalSelection,
  revokeAccess,
} from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

const QUESTION = "When is the Halden Press order due to arrive?";
const RELEASED_ANSWER =
  "The Halden Press order is booked for delivery on Thursday 14 May.\n" +
  "The courier is Ridgeway Logistics.\n" +
  "Someone at Halden Press is expecting the pallet at the loading bay.";
const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const run = promisify(execFile);
const DAY_MS = 24 * 60 * 60_000;

describe("managed agent integration on a gateway without Watches", () => {
  let harness: SyntheticE2EHarness;
  let home: string;
  let cliConfig: string;
  let fakeBin: string;
  let credentialsPath: string;
  let deviceId: string;
  let credentialId: string;
  let grantId: string;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "default",
      agentBackend: "replay",
      extraInference: { assignments: { "privacy-reviewer": "replay" } },
    });
    await harness.start();
    await assertGatewayHasNoWatches();
    home = mkdtempSync(join(tmpdir(), "omnesis-graduated-openclaw-"));
    cliConfig = mkdtempSync(join(tmpdir(), "omnesis-graduated-cli-"));
    fakeBin = mkdtempSync(join(tmpdir(), "omnesis-graduated-bin-"));
    credentialsPath = join(home, "omnesis", "integration.json");
    for (const opener of ["open", "xdg-open"]) {
      writeFileSync(join(fakeBin, opener), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    writeFileSync(join(home, "openclaw.json"), "{}\n");
    await connectOpenClaw();
  }, 420_000);

  afterAll(async () => {
    await harness.destroy();
    for (const directory of [home, cliConfig, fakeBin]) {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("advertises Watches as unavailable without hiding the rest of itself", async () => {
    const health = await harness.gatewayJson<{
      experimental: boolean;
      capabilities: { subscriptions: boolean };
      version: string;
    }>("/health");
    expect(health.experimental).toBe(false);
    expect(health.capabilities).toMatchObject({ subscriptions: false });
    expect(health.version).toMatch(/^\d+\.\d+\.\d+/u);

    // The half that stays gated is still gated, and stays indistinguishable
    // from absent rather than answering 401 or 403.
    expect((await harness.gatewayFetch("/subscriptions")).status).toBe(404);
  });

  test("connect pairs the device and completes OAuth on a default gateway", () => {
    // Nothing about this ceremony needed experimental mode. The device is
    // paired as an agent, and the operator's approval produced a credential
    // bound to it.
    expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
    const credentials = readCredentials();
    expect(credentials.oauth.tokens).toMatchObject({
      access_token: expect.stringMatching(/^omn_oat_/u),
      refresh_token: expect.stringMatching(/^omn_ort_/u),
    });
    expect(credentials.oauth.tokensObtainedAt).toEqual(expect.any(Number));
    expect(deviceId).toEqual(expect.any(String));
    expect(installedOpenClawEntry()).toEqual(expect.any(String));
  });

  test("the installed skill describes the gateway in front of it, not the product", () => {
    const skill = readFileSync(join(home, "skills", "omnesis", "SKILL.md"), "utf8");
    expect(skill).toContain("omnesis_answer");
    // No dangling tool names, and no prose promising a capability this
    // gateway does not have.
    expect(skill).not.toContain("omnesis_subscriptions");
    expect(skill).not.toContain("omnesis_subscription_answer");
    expect(skill).toContain("Watches are not available on this installation");
    // The plugin reads this back when it registers, before it has spoken to
    // any gateway.
    expect(readCredentials().capabilities).toEqual({ subscriptions: false });
  });

  test("the started plugin registers exactly the tools the gateway supports", async () => {
    expect((await probePlugin()).tools).toEqual(["omnesis_answer"]);
  });

  test("transcripts and Answer work exactly as they do with Watches on", async () => {
    // The plugin's own least-privilege ingestion token, not the admin key —
    // the point is that a paired harness can push on a default gateway.
    const ingested = await fetch(`${harness.gatewayUrl}/agent-messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${readCredentials().ingestionToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          {
            harness: "openclaw",
            channel: "cli",
            chatId: "chat-fictional-graduated",
            id: "msg-fictional-graduated-1",
            role: "user",
            text: "Remind me to check the Halden Press delivery.",
            occurredAt: Date.now(),
          },
        ],
      }),
    });
    expect(ingested.status, await ingested.clone().text()).toBe(202);

    const answered = await askColdPlugin();
    expect(answered).toMatchObject({ answer: RELEASED_ANSWER });
  }, 120_000);

  test("the start-time keepalive renews a ticket that is nearly spent", async () => {
    // Age the stored ticket rather than the wall clock: the remaining life is
    // exactly what the keepalive reasons about, and it is written down.
    const before = readCredentials();
    writeCredentials({
      ...before,
      oauth: { ...before.oauth, tokensObtainedAt: Date.now() - 24 * DAY_MS },
    });

    const probe = await probePlugin();
    expect(probe.warnings.join("\n")).not.toMatch(/renewal failed/u);
    const after = readCredentials();
    expect(after.oauth.tokens.refresh_token).not.toBe(before.oauth.tokens.refresh_token);
    expect(after.oauth.tokensObtainedAt).toBeGreaterThan(Date.now() - 5 * 60_000);
  }, 120_000);

  test("the start-time keepalive leaves a fresh ticket alone", async () => {
    const before = readCredentials();
    writeCredentials({
      ...before,
      oauth: { ...before.oauth, tokensObtainedAt: Date.now() - DAY_MS },
    });

    await probePlugin();
    expect(readCredentials().oauth.tokens.refresh_token).toBe(before.oauth.tokens.refresh_token);
  }, 120_000);

  test("a lapsed ticket is recovered headlessly, without a browser", async () => {
    // The cliff: nobody asked this installation anything for a month, so the
    // refresh token is gone and the only ordinary way back is interactive.
    await harness.restartGateway(() => expireRefreshTokens());
    const before = readCredentials();
    expect(await agentAuthorizationState()).toEqual({
      status: "needs-reauthorization",
      remedy: "omnesis connect openclaw --refresh",
    });

    const answered = await askColdPlugin();
    expect(answered).toMatchObject({ answer: RELEASED_ANSWER });

    const after = readCredentials();
    expect(after.oauth.tokens.refresh_token).not.toBe(before.oauth.tokens.refresh_token);
    // Recovery re-keys the approval that already existed; it never mints one.
    expect(credentialIdsForDevice()).toEqual([credentialId]);
    expect(await agentAuthorizationState()).toEqual({ status: "authorized" });
  }, 120_000);

  test("recovery stops the moment the operator revokes the grant", async () => {
    // The positive control first, so the refusal below is attributable to the
    // revocation rather than to the request being wrong in some other way.
    const allowed = await reissue();
    expect(allowed.status, await allowed.clone().text()).toBe(200);

    const portal = await loginPortal({ gatewayUrl: harness.gatewayUrl, apiKey: harness.apiKey });
    await revokeAccess(harness.gatewayUrl, portal, { kind: "grant", id: grantId });

    const refused = await reissue();
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ code: "NO_APPROVED_CREDENTIAL" });
    // The revoked grant is still revoked: a management token cannot bring one
    // back, only re-key one that is live.
    expect(await agentAuthorizationState()).toEqual({
      status: "needs-reauthorization",
      remedy: "omnesis connect openclaw --refresh",
    });
  }, 60_000);

  /**
   * Ask for a re-issue exactly as the plugin does — with the device's own
   * management token. A bare `fetch`, because the harness helper overwrites
   * Authorization with the gateway's admin key, which would send the request
   * as a different device entirely and refuse for the wrong reason.
   */
  async function reissue(): Promise<Response> {
    return fetch(`${harness.gatewayUrl}/agent-integration/oauth-reissue`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${readCredentials().managementToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ clientId: oauthClientId() }),
    });
  }

  /**
   * Refuse to run against the wrong kind of gateway.
   *
   * Every assertion in this file is about what a gateway *without* the Watch
   * runtime produces, and the whole ceremony below is driven by what the
   * gateway advertises — so pointed at a gateway that does have Watches, this
   * suite would install a perfectly correct integration and then report three
   * product failures. Checked before the ceremony rather than inside a test,
   * so the message says "this suite is misconfigured" and not "the capability
   * flag is broken".
   */
  async function assertGatewayHasNoWatches(): Promise<void> {
    const health = await harness.gatewayJson<{
      capabilities?: { subscriptions?: boolean };
    }>("/health");
    if (health.capabilities?.subscriptions !== false) {
      throw new Error(
        "this suite requires a gateway with subscriptions unavailable, but /health advertised " +
          `${JSON.stringify(health.capabilities)} — check the harness environment, not the product`,
      );
    }
  }

  async function connectOpenClaw(): Promise<void> {
    const pairing = await harness.gatewayJson<{ pairingCode: string }>("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({
        name: "Fictional openclaw graduated integration",
        kind: "agent",
        scopes: ["subscriptions:receive"],
      }),
    });
    let running: SpawnedConnect | undefined = spawnConnect({
      repositoryRoot,
      args: [
        "openclaw",
        "--gateway-url",
        harness.gatewayUrl,
        "--code",
        pairing.pairingCode,
        "--dir",
        home,
      ],
      fakeBin,
      cliConfigDir: cliConfig,
    });
    try {
      const pending = await waitForPendingAuthorization(running);
      const portal = await loginPortal({ gatewayUrl: harness.gatewayUrl, apiKey: harness.apiKey });
      const overview = await accessOverview(harness.gatewayUrl, portal);
      await decideOAuthAuthorization(harness.gatewayUrl, portal, pending.id, {
        decision: "approve",
        selection: newAnswerPrincipalSelection(overview, "fictional graduated principal", {
          grantName: "answer grant for a default gateway",
          credentialLabel: "credential for a default gateway",
        }),
      });
      const completed = await waitForExit(running, 120_000);
      running = undefined;
      expect(completed.code, completed.output).toBe(0);
    } finally {
      if (running) await terminateConnect(running);
    }
    const identity = withDb((db) =>
      db
        .prepare(
          `SELECT c.id AS credentialId, c.grant_id AS grantId, c.execution_device_id AS deviceId
           FROM principal_credentials c
           WHERE c.execution_device_id IS NOT NULL`,
        )
        .get(),
    ) as { credentialId: string; grantId: string; deviceId: string } | undefined;
    if (!identity) throw new Error("connect produced no execution-bound credential");
    credentialId = identity.credentialId;
    grantId = identity.grantId;
    deviceId = identity.deviceId;
  }

  async function waitForPendingAuthorization(running: SpawnedConnect): Promise<{ id: string }> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const row = withDb(
        (db) =>
          (db
            .prepare(
              `SELECT id FROM oauth_authorization_requests
               WHERE status = 'pending' AND execution_device_id IS NOT NULL
               ORDER BY created_at DESC LIMIT 1`,
            )
            .get() as { id: string } | undefined) ?? null,
      );
      if (row) return row;
      if (running.spawnError) throw running.spawnError;
      if (running.exitResult) {
        throw new Error(
          `connect exited before creating an authorization request ` +
            `(${running.exitResult.code ?? running.exitResult.signal})\n${running.output.join("")}`,
        );
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    await terminateConnect(running);
    throw new Error("connect did not create an authorization request before the deadline");
  }

  /** Boot the installed plugin in a cold process and report what it offered. */
  async function probePlugin(): Promise<{ tools: string[]; warnings: string[] }> {
    const result = await run(
      process.execPath,
      [resolve(repositoryRoot, "packages/agent-integration/test/openclaw_plugin_probe.mjs")],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          OMNESIS_OPENCLAW_ENTRY_PATH: installedOpenClawEntry(),
          OMNESIS_OPENCLAW_STATE_DIR: home,
        },
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return JSON.parse(result.stdout) as { tools: string[]; warnings: string[] };
  }

  async function askColdPlugin(): Promise<{ answer?: string }> {
    const result = await run(
      process.execPath,
      [resolve(repositoryRoot, "packages/agent-integration/test/openclaw_mcp_probe.mjs")],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          OMNESIS_OPENCLAW_ENTRY_PATH: installedOpenClawEntry(),
          OMNESIS_OPENCLAW_STATE_DIR: home,
          OMNESIS_OPENCLAW_QUESTION: QUESTION,
        },
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const parsed = JSON.parse(result.stdout) as { details?: { response?: unknown } };
    return (parsed.details?.response ?? {}) as { answer?: string };
  }

  async function agentAuthorizationState(): Promise<unknown> {
    const listed = await harness.gatewayJson<{
      items: Array<{ id: string; agentAuthorization?: unknown }>;
    }>("/admin/devices");
    const row = listed.items.find((item) => item.id === deviceId);
    if (!row) throw new Error("the agent device is missing from the device list");
    return row.agentAuthorization;
  }

  function readCredentials() {
    return JSON.parse(readFileSync(credentialsPath, "utf8")) as {
      ingestionToken: string;
      managementToken: string;
      capabilities?: { subscriptions: boolean };
      oauth: {
        clientInformation: { client_id?: string };
        tokens: { access_token?: string; refresh_token?: string };
        tokensObtainedAt?: number;
      };
    };
  }

  function writeCredentials(value: unknown): void {
    writeFileSync(credentialsPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }

  function oauthClientId(): string {
    const clientId = readCredentials().oauth.clientInformation.client_id;
    if (!clientId) throw new Error("the installed integration has no OAuth client");
    return clientId;
  }

  function installedOpenClawEntry(): string {
    const matches = globSync(
      "npm/projects/*/node_modules/@omnesis/agent-integration/openclaw-entry.mjs",
      { cwd: home },
    );
    if (matches.length !== 1) {
      throw new Error(`expected one installed OpenClaw entry, found ${matches.length}`);
    }
    return join(home, matches[0]!);
  }

  function expireRefreshTokens(): void {
    withDb((db) =>
      db
        .prepare(
          "UPDATE oauth_refresh_tokens SET expires_at = 0 WHERE credential_id = ? AND revoked_at IS NULL",
        )
        .run(credentialId),
    );
    withDb((db) =>
      db
        .prepare("UPDATE oauth_access_tokens SET expires_at = 0 WHERE credential_id = ?")
        .run(credentialId),
    );
  }

  function credentialIdsForDevice(): string[] {
    return withDb((db) =>
      (
        db
          .prepare("SELECT id FROM principal_credentials WHERE execution_device_id = ?")
          .all(deviceId) as Array<{ id: string }>
      ).map((row) => row.id),
    );
  }

  function withDb<T>(operation: (db: Database.Database) => T): T {
    const db = new Database(harness.getDbPath());
    try {
      return operation(db);
    } finally {
      db.close();
    }
  }
});
