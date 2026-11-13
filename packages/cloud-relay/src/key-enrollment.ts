// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { keyCompletionSchema } from "./gateway-key-auth.js";
import { bindingOrigin } from "./gateway-binding.js";
import { RelayError } from "./tunnels.js";
import type { GatewayKeyAuthentication } from "./gateway-key-auth.js";
import type { RelayAccounts } from "./accounts.js";
import type { Identity, RelaySessions } from "./identity.js";
import type { RelayRecovery } from "./relay-recovery.js";

interface KeyEnrollmentOptions {
  authentication: GatewayKeyAuthentication;
  accounts: RelayAccounts;
  sessions: RelaySessions;
  recovery?: RelayRecovery;
  issueSession(
    identity: Identity,
  ): Promise<{ token: string; accountId: string; expiresAt: number }>;
  hostnameProof(hostname: string, account: string, gatewayId: string): Promise<boolean>;
  controlOrigin(): string;
  privateEnrollmentAllowed(): boolean;
  closeMigratedAccount(account: string): void;
}

/** Fresh possession proofs and independent recovery authorization precede every durable routing mutation. */
export async function completeKeyEnrollment(input: unknown, options: KeyEnrollmentOptions) {
  let completed: ReturnType<GatewayKeyAuthentication["complete"]>;
  let completion: ReturnType<typeof keyCompletionSchema.parse>;
  try {
    completion = keyCompletionSchema.parse(input);
    completed = options.authentication.complete(completion);
  } catch (error) {
    throw error instanceof RelayError ? error : new RelayError(400, "Invalid gateway key proof");
  }
  const receipt = options.recovery?.registration(
    completion.recoveryReceipt,
    completed.registration,
  );
  if (!options.recovery && completion.recoveryReceipt !== undefined)
    throw new RelayError(503, "Independent gateway recovery is not configured");
  const session = await options.issueSession(completed.identity);
  if (
    !(await options.hostnameProof(
      bindingOrigin(completed.binding.publicOrigin).hostname,
      session.accountId,
      completed.binding.gatewayId,
    ))
  )
    throw new RelayError(403, "Hostname ownership proof required");
  let allowNew = options.privateEnrollmentAllowed();
  if (receipt !== undefined) allowNew = true;
  if (!allowNew && !options.accounts.keyEnrollmentExempt(session.accountId, completed.binding)) {
    // A gateway nobody registered here gets its own answer, once both its keys are proven: one
    // whose Omnesis account was deleted learns from it that it is no longer connected.
    if (!completion.enrollmentToken)
      throw options.accounts.ownerForGateway(completed.binding.gatewayId) === undefined
        ? new RelayError(410, "This gateway is not registered")
        : new RelayError(403, "A gateway enrollment invitation is required");
    try {
      await options.sessions.verifyEnrollmentInvitation(
        completion.enrollmentToken,
        completed.binding.gatewayId,
        options.controlOrigin(),
      );
    } catch {
      throw new RelayError(403, "Invalid gateway enrollment invitation");
    }
    allowNew = true;
  }
  // Async issuer/DNS checks must not extend an expired authorization into a durable registration.
  options.recovery?.registration(receipt, completed.registration);
  const enrolled = options.accounts.registerKeyBinding(
    session.accountId,
    completed.binding,
    allowNew,
    receipt,
  );
  if (enrolled.migratedAccountId !== undefined)
    options.closeMigratedAccount(enrolled.migratedAccountId);
  return session;
}
