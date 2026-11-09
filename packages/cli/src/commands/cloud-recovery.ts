// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { cloudRelayEnabled } from "@omnesis/core";
import { CliError, EXIT_USER_ERROR } from "@omnesis/cli-shared";

export type CloudRecoveryOperation =
  | "recovery-create-authority"
  | "recovery-sign-receipt"
  | "recovery-sign-policy"
  | "recovery-policy-digest"
  | "recovery-rotate-session-key"
  | "recovery-request";

/** Offline/local operations use explicit private file paths; runtime output contains public results only. */
export async function runCloudRecoveryCommand(command: CloudRecoveryOperation): Promise<void> {
  if (!cloudRelayEnabled())
    throw new CliError("Cloud recovery requires OMNESIS_CLOUD_RELAY_ENABLED=1", EXIT_USER_ERROR);
  try {
    const { runRelayCommand } = await import("@omnesis/cloud-relay/runtime");
    await runRelayCommand(command, process.env);
  } catch {
    throw new CliError(
      "Cloud recovery operation failed; check the local identity, independent authority and policy files.",
      EXIT_USER_ERROR,
    );
  }
}

export const cloudRecoveryCommands = {
  "recovery-create-authority": defineCommand({
    meta: {
      name: "recovery-create-authority",
      description: "Offline operator: create an independent recovery signing authority",
    },
    run: () => runCloudRecoveryCommand("recovery-create-authority"),
  }),
  "recovery-sign-receipt": defineCommand({
    meta: {
      name: "recovery-sign-receipt",
      description: "Offline operator: sign a gateway ownership recovery receipt",
    },
    run: () => runCloudRecoveryCommand("recovery-sign-receipt"),
  }),
  "recovery-sign-policy": defineCommand({
    meta: {
      name: "recovery-sign-policy",
      description: "Offline operator: sign the current revocation and recovery policy",
    },
    run: () => runCloudRecoveryCommand("recovery-sign-policy"),
  }),
  "recovery-policy-digest": defineCommand({
    meta: {
      name: "recovery-policy-digest",
      description: "Offline operator: print the signed policy digest for independent configuration",
    },
    run: () => runCloudRecoveryCommand("recovery-policy-digest"),
  }),
  "recovery-rotate-session-key": defineCommand({
    meta: {
      name: "recovery-rotate-session-key",
      description: "Relay operator: replace only the relay session key; restart required",
    },
    run: () => runCloudRecoveryCommand("recovery-rotate-session-key"),
  }),
  "recovery-request": defineCommand({
    meta: {
      name: "recovery-request",
      description: "Gateway: export a public recovery request using its existing owner identity",
    },
    run: () => runCloudRecoveryCommand("recovery-request"),
  }),
};
