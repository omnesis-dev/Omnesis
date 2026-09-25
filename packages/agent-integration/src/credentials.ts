// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { tlsTrustSchema } from "./tls.js";

export const integrationCredentialsSchema = z
  .object({
    gatewayUrl: z.string().url(),
    deliveryToken: z.string().min(1),
    ingestionToken: z.string().min(1),
    managementToken: z.string().min(1),
    oauth: z
      .object({
        redirectUri: z.string().url(),
        clientInformation: z.record(z.string(), z.unknown()),
        tokens: z.record(z.string(), z.unknown()),
        discoveryState: z.record(z.string(), z.unknown()).optional(),
        codeVerifier: z.string().optional(),
        authorizationState: z.string().min(32).optional(),
        /**
         * When the stored token set was issued, in epoch milliseconds.
         *
         * The refresh token rotates on use and expires on a timer, and the
         * OAuth token response says nothing about that timer. This stamp is
         * how the plugin knows how much of the ticket is left, and therefore
         * when to spend it on a keepalive rather than wait for a question
         * that may not come this month.
         */
        tokensObtainedAt: z.number().int().nonnegative().optional(),
      })
      .strict(),
    tls: tlsTrustSchema.optional(),
    /**
     * What the gateway said it could do, recorded by `omnesis connect` and
     * refreshed by the running plugin.
     *
     * Written only when it contradicts what the file already implies, so it is
     * absent both in a file written before the capability existed and in one
     * written against a gateway that offers Watches — the two cases
     * `subscriptionsAvailable` reads identically, and correctly.
     */
    capabilities: z
      .object({
        subscriptions: z.boolean(),
      })
      .strict()
      .optional(),
    maxConcurrentRuns: z.number().int().positive().max(128).optional(),
  })
  .strict();

export type IntegrationCredentials = z.infer<typeof integrationCredentialsSchema>;

export type IntegrationOAuthState = IntegrationCredentials["oauth"];

export const legacyIntegrationCredentialsSchema = z
  .object({
    gatewayUrl: z.string().url(),
    deliveryToken: z.string().min(1),
    ingestionToken: z.string().min(1),
    tls: tlsTrustSchema.optional(),
    maxConcurrentRuns: z.number().int().positive().max(128).optional(),
  })
  .strict();

export type LegacyIntegrationCredentials = z.infer<typeof legacyIntegrationCredentialsSchema>;
export type OperationalIntegrationCredentials =
  | IntegrationCredentials
  | LegacyIntegrationCredentials;

function readJson(path: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read integration credentials at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  return value;
}

/**
 * Load the native integration's operational credentials and principal OAuth state.
 *
 * Delivery, ingestion, and subscription management remain authorities of the
 * paired execution device. The management bearer cannot read corpus data;
 * ordinary MCP access uses the independently granted OAuth principal instead.
 */
export function loadIntegrationCredentials(path: string): IntegrationCredentials {
  return integrationCredentialsSchema.parse(readJson(path));
}

/** Load the device authorities that remain usable before the OAuth upgrade. */
export function loadOperationalIntegrationCredentials(
  path: string,
): OperationalIntegrationCredentials {
  const value = readJson(path);
  const current = integrationCredentialsSchema.safeParse(value);
  if (current.success) return current.data;
  return legacyIntegrationCredentialsSchema.parse(value);
}

export function hasIntegrationOAuth(
  credentials: OperationalIntegrationCredentials,
): credentials is IntegrationCredentials {
  return "oauth" in credentials && "managementToken" in credentials;
}

/**
 * Preserve a pre-access-grants plugin's operational device credentials while
 * adding the separate OAuth principal state required by V1.
 */
export function upgradeLegacyIntegrationCredentials(
  path: string,
  managementToken: string,
): IntegrationCredentials {
  const current = readJson(path);
  const alreadyCurrent = integrationCredentialsSchema.safeParse(current);
  if (alreadyCurrent.success) return alreadyCurrent.data;
  const legacy = legacyIntegrationCredentialsSchema.parse(current);
  const upgraded = integrationCredentialsSchema.parse({
    ...legacy,
    managementToken,
    oauth: {
      redirectUri: "http://127.0.0.1:0/callback",
      clientInformation: {},
      tokens: {},
    },
  });
  writeIntegrationCredentials(path, upgraded);
  return upgraded;
}

/** Atomically persist refreshed principal credentials without relaxing the secret-file mode. */
export function updateIntegrationOAuthState(path: string, oauth: IntegrationOAuthState): void {
  const current = loadIntegrationCredentials(path);
  const next = integrationCredentialsSchema.parse({ ...current, oauth });
  writeIntegrationCredentials(path, next);
}

/**
 * Record what the gateway last said it could do, without disturbing anything
 * else in the file.
 *
 * Re-reads first, for the same reason `updateIntegrationOAuthState` does: a
 * running plugin rotates the OAuth tokens in this file whenever it asks a
 * question, so writing back a snapshot taken before a network round-trip
 * would restore an already-spent refresh token.
 */
export function updateIntegrationCapabilities(
  path: string,
  capabilities: IntegrationCredentials["capabilities"],
): IntegrationCredentials {
  const current = loadIntegrationCredentials(path);
  const next = integrationCredentialsSchema.parse({ ...current, capabilities });
  writeIntegrationCredentials(path, next);
  return next;
}

/** Crash-durable secret-file persistence shared by connect and runtime refresh. */
export function writeIntegrationCredentials(
  path: string,
  credentials: IntegrationCredentials,
): void {
  const checked = integrationCredentialsSchema.parse(credentials);
  writeSecretFileDurably(path, `${JSON.stringify(checked, null, 2)}\n`);
}

function writeSecretFileDurably(path: string, data: string): void {
  const parent = dirname(path);
  const temporary = `${path}.omnesis-${process.pid.toString(36)}${randomBytes(6).toString("hex")}.tmp`;
  mkdirSync(parent, { recursive: true });
  try {
    writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    const file = openSync(temporary, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the write error; the scratch file may not have been created.
    }
    throw error;
  }
  if (process.platform === "win32") return;
  let directory: number;
  try {
    directory = openSync(parent, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(directory);
  } catch {
    // Some filesystems cannot fsync directories; the file itself is durable.
  } finally {
    closeSync(directory);
  }
}

/**
 * Whether this installation should offer Watch management at all.
 *
 * Watch management and Watch-reaction delivery sit on the gateway's Watch
 * runtime, which is gated separately from the rest of the agent integration.
 * Registering the tools anyway would put a lever in front of the model that
 * answers 404, and describing them in the skill would promise a capability
 * this gateway does not have.
 *
 * A file with no recorded capability predates the field, and could only have
 * been written by a CLI that refused to install against a gateway without
 * Watches — so the honest reading of its silence is "available".
 */
export function subscriptionsAvailable(credentials: IntegrationCredentials): boolean {
  return credentials.capabilities?.subscriptions ?? true;
}
