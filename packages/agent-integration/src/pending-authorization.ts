// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one interactive approval an integration is waiting for.
 *
 * An approval request lives on the gateway for its full lifetime whether or
 * not the process that opened it is still polling. The operator may approve
 * it from the phone minutes later, after that process timed out, crashed, or
 * was stopped by an update. So the request is recorded beside the credential
 * file the moment it exists, with everything needed to finish it: the
 * browser handle the gateway answers status and completion on, and the PKCE
 * verifier and `state` it was opened with. The next `omnesis connect` picks
 * that request up — collecting an approval that already happened, or waiting
 * on one that is still open — instead of opening a second one the operator
 * would have to approve again.
 *
 * It is a file of its own rather than fields in `integration.json`, whose
 * schema is strict: a plugin older than this file would refuse a credential
 * file carrying fields it does not know. The verifier and state are copied
 * rather than read back from the credential file because a running plugin
 * rewrites that file when it renews its tokens, and the SDK overwrites both
 * whenever it prepares an authorization of its own.
 *
 * The Hermes adapter reads the same file for the same question — is an
 * approval still open? — so its name and shape are a contract between the
 * two runtimes.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { z } from "zod";

import { writeSecretFileDurably } from "./credentials.js";

// Not strict: a record written by a newer CLI with fields this version does
// not know must still read as the request it is, or a plugin would take its
// verifier for an attempt of unknown age and stand its keepalive down.
const pendingAuthorizationSchema = z.object({
  gatewayUrl: z.string().url(),
  clientId: z.string().min(1),
  handle: z.string().min(1),
  consentUrl: z.string().url(),
  expiresAt: z.number().int().nonnegative(),
  codeVerifier: z.string().min(1),
  state: z.string().min(1),
});

export type PendingIntegrationAuthorization = z.infer<typeof pendingAuthorizationSchema>;

/** Where the pending approval for the credential file at `credentialsPath` is kept. */
export function pendingAuthorizationPath(credentialsPath: string): string {
  return `${credentialsPath}.pending-authorization`;
}

/**
 * The recorded approval request, or null when there is none.
 *
 * An unreadable or malformed record counts as none: it can name no request
 * this process could finish, and the worst that follows is one fresh request.
 */
export function loadPendingAuthorization(
  credentialsPath: string,
): PendingIntegrationAuthorization | null {
  let text: string;
  try {
    text = readFileSync(pendingAuthorizationPath(credentialsPath), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = pendingAuthorizationSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function savePendingAuthorization(
  credentialsPath: string,
  pending: PendingIntegrationAuthorization,
): void {
  writeSecretFileDurably(
    pendingAuthorizationPath(credentialsPath),
    `${JSON.stringify(pendingAuthorizationSchema.parse(pending), null, 2)}\n`,
  );
}

/**
 * Drop the record. With `handle`, only when it still names that request: a
 * run ending its own request must not drop one another run has since
 * recorded in its place.
 */
export function clearPendingAuthorization(credentialsPath: string, handle?: string): void {
  if (handle !== undefined && loadPendingAuthorization(credentialsPath)?.handle !== handle) return;
  try {
    unlinkSync(pendingAuthorizationPath(credentialsPath));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
