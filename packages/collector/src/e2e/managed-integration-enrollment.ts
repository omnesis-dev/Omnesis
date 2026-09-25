// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The real `omnesis connect` ceremony shared by managed-integration E2Es.
 *
 * Pairing, OAuth approval, and plugin installation are one transaction from
 * the operator's perspective. Keeping the driver here prevents the ordinary
 * behavior suite and the pinned third-party conformance lane from growing two
 * subtly different models of that ceremony.
 */

import Database from "better-sqlite3";

import {
  spawnConnect,
  terminateConnect,
  waitForExit,
  type SpawnConnectOptions,
  type SpawnedConnect,
} from "./connect-process.js";
import {
  accessOverview,
  decideOAuthAuthorization,
  loginPortal,
  newAnswerPrincipalSelection,
} from "./mcp-oauth-helper.js";

export type ManagedHarness = "openclaw" | "hermes";

export interface ManagedIntegrationEnrollmentOptions {
  harness: ManagedHarness;
  repositoryRoot: string;
  gatewayUrl: string;
  portalApiKey: string;
  gatewayDbPath: string;
  home: string;
  fakeBin: string;
  cliConfigDir: string;
  createPairingCode(): Promise<string>;
  /** Exact TLS pin for a newly spawned gateway with no saved trust state. */
  trustFingerprint?: string;
  connectEnv?: SpawnConnectOptions["env"];
  inheritConnectEnv?: boolean;
}

export interface ManagedIntegrationEnrollment {
  authorizationRequestId: string;
  connectOutput: string;
}

export async function enrollManagedIntegration(
  options: ManagedIntegrationEnrollmentOptions,
): Promise<ManagedIntegrationEnrollment> {
  const excludedRequestIds = authorizationRequestIds(options.gatewayDbPath);
  const pairingCode = await options.createPairingCode();
  let running: SpawnedConnect | undefined;
  try {
    running = spawnConnect({
      repositoryRoot: options.repositoryRoot,
      args: [
        options.harness,
        "--gateway-url",
        options.gatewayUrl,
        "--code",
        pairingCode,
        "--dir",
        options.home,
        ...(options.trustFingerprint ? ["--trust-fingerprint", options.trustFingerprint] : []),
      ],
      fakeBin: options.fakeBin,
      cliConfigDir: options.cliConfigDir,
      env: options.connectEnv,
      inheritEnv: options.inheritConnectEnv,
    });
    const pending = await waitForPendingAuthorization(
      options.gatewayDbPath,
      excludedRequestIds,
      running,
    );
    const portal = await loginPortal({
      gatewayUrl: options.gatewayUrl,
      apiKey: options.portalApiKey,
    });
    const overview = await accessOverview(options.gatewayUrl, portal);
    await decideOAuthAuthorization(options.gatewayUrl, portal, pending.id, {
      decision: "approve",
      selection: newAnswerPrincipalSelection(
        overview,
        `Fictional ${options.harness} managed principal`,
        {
          grantName: `${options.harness} managed Answer grant`,
          credentialLabel: `${options.harness} managed credential`,
        },
      ),
    });
    const completed = await waitForExit(running, 90_000);
    running = undefined;
    if (completed.code !== 0) {
      throw new Error(
        `omnesis connect ${options.harness} exited with ${completed.code}\n${completed.output}`,
      );
    }
    return {
      authorizationRequestId: pending.id,
      connectOutput: completed.output,
    };
  } finally {
    if (running) await terminateConnect(running);
  }
}

function authorizationRequestIds(dbPath: string): Set<string> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return new Set(
      (
        db.prepare("SELECT id FROM oauth_authorization_requests").all() as Array<{ id: string }>
      ).map((row) => row.id),
    );
  } finally {
    db.close();
  }
}

async function waitForPendingAuthorization(
  dbPath: string,
  excluded: ReadonlySet<string>,
  running: SpawnedConnect,
): Promise<{ id: string }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const db = new Database(dbPath, { readonly: true });
    let row: { id: string } | undefined;
    try {
      row = db
        .prepare(
          `SELECT id FROM oauth_authorization_requests
           WHERE status = 'pending' AND execution_device_id IS NOT NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get() as { id: string } | undefined;
    } finally {
      db.close();
    }
    if (row && !excluded.has(row.id)) return row;
    if (running.spawnError) throw running.spawnError;
    if (running.exitResult) {
      throw new Error(
        `connect exited before creating an authorization request (${running.exitResult.code ?? running.exitResult.signal})\n${running.output.join("")}`,
      );
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`omnesis connect did not create an authorization request before the deadline`);
}
