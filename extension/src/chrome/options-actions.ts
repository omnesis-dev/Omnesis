// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeGatewayUrl } from "../push/index.js";
import { normalizeProfileLabel } from "./storage.js";
import type { OptionsToSwMessage, PairingStateAck } from "./messages.js";

interface PairingActions {
  requestPermission: () => Promise<void>;
  send: (message: OptionsToSwMessage) => Promise<unknown>;
}

/** Request host access, then ask the worker to redeem and atomically commit a pair. */
export async function commitBrowserPairing(
  rawGatewayUrl: string,
  pairingCode: string,
  rawProfileLabel: string,
  actions: PairingActions,
): Promise<string | null> {
  // Validate before showing Chrome's host-access prompt.
  const gatewayUrl = normalizeGatewayUrl(rawGatewayUrl);
  const profileLabel = validatedProfileLabel(rawProfileLabel);
  await actions.requestPermission();
  const ack = (await actions.send({
    type: "pair-browser",
    gatewayUrl,
    pairingCode,
    profileLabel,
  })) as PairingStateAck | undefined;
  if (!ack?.ok) throw new Error(ack?.reason ?? "the extension could not save the pairing");
  return ack.warning ?? null;
}

/** Update the human label without replacing the stable pairing/device identity. */
export async function saveBrowserProfileLabel(
  rawProfileLabel: string,
  actions: PairingActions,
): Promise<void> {
  const profileLabel = validatedProfileLabel(rawProfileLabel);
  const ack = (await actions.send({ type: "set-profile-label", profileLabel })) as
    | PairingStateAck
    | undefined;
  if (!ack?.ok) throw new Error(ack?.reason ?? "the extension could not save the profile name");
}

/** Ask the worker to clear the credential and permission as one ordered transition. */
export async function unpairBrowser(actions: PairingActions): Promise<string | null> {
  const ack = (await actions.send({ type: "unpair" })) as PairingStateAck | undefined;
  if (!ack?.ok) throw new Error(ack?.reason ?? "background worker unavailable");
  return ack.warning ?? null;
}

/** Relinquish a grant left after an abandoned or failed pairing attempt. */
export async function revokeUnpairedCaptureAccess(actions: PairingActions): Promise<string | null> {
  const ack = (await actions.send({ type: "revoke-capture-access" })) as
    | PairingStateAck
    | undefined;
  if (!ack?.ok) throw new Error(ack?.reason ?? "background worker unavailable");
  return ack.warning ?? null;
}

/** Preserve a committed action's result even if its follow-up UI refresh fails. */
export async function withBestEffortRefresh<T>(
  action: () => Promise<T>,
  refresh: () => Promise<void>,
): Promise<T> {
  const result = await action();
  try {
    await refresh();
  } catch {
    // Durable state is authoritative; reopening the page renders it again.
  }
  return result;
}

/** Grant page access and require the worker to activate dynamic capture. */
export async function grantCaptureAccess(actions: PairingActions): Promise<void> {
  await actions.requestPermission();
  const ack = (await actions.send({ type: "check-now" })) as PairingStateAck | undefined;
  if (!ack?.ok) throw new Error(ack?.reason ?? "the extension could not activate page capture");
}

function validatedProfileLabel(rawProfileLabel: string): string {
  const profileLabel = normalizeProfileLabel(rawProfileLabel);
  if (profileLabel) return profileLabel;
  if (!rawProfileLabel.trim()) throw new Error("Enter this Chrome profile's name.");
  throw new Error("Chrome profile name is too long.");
}

/** Load both Options views without leaking an unhandled startup rejection. */
export async function loadInitialOptionsState(
  loadPairing: () => Promise<void>,
  loadExclusions: () => Promise<void>,
): Promise<string | null> {
  try {
    await Promise.all([loadPairing(), loadExclusions()]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
