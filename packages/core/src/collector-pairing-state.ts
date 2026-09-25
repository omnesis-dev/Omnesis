// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The collector's own record of whether it is still paired with its gateway.
 *
 * A revoked device is indistinguishable from a mistyped token at the wire:
 * both are a 401. The difference that matters to an operator is whether the
 * credential ever worked — a token that authenticated yesterday and is
 * refused today means the device was revoked and needs a repair code, while
 * one that never authenticated means the install was never wired up. This
 * module records the first fact so the second can be inferred, and persists
 * the verdict where `omnesis service status` can read it: the collector that
 * discovers it is locked out is a daemon nobody is watching.
 *
 * The file holds no secret. A credential is identified by a truncated
 * SHA-256 of the token so a rotation is detectable without the token itself
 * ever landing in a world-readable status file.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirSync } from "./security-files.js";

/** File name under the config dir; stable so the CLI can find it. */
export const COLLECTOR_PAIRING_STATE_FILE = "collector-pairing-state.json";

export interface CollectorPairingState {
  state: "paired" | "needs-pairing";
  /** The name this collector registers under, and the repair target. */
  deviceName: string;
  /** Gateway the verdict is about — a collector may be re-pointed. */
  gatewayUrl: string;
  /** Truncated SHA-256 of the credential this verdict describes. */
  tokenFingerprint: string;
  /** When that credential last authenticated; null if it never did. */
  lastAuthenticatedAt: number | null;
  /** When the gateway last refused it; null while paired. */
  unauthorizedAt: number | null;
  /** Ready-to-run command that mints a repair code on the gateway host. */
  repairCommand: string | null;
}

/**
 * Stable, non-reversible identifier for a credential. Truncated because the
 * only question asked of it is "same token as last time?".
 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function statePath(configDir: string): string {
  return join(configDir, COLLECTOR_PAIRING_STATE_FILE);
}

function isStateName(value: unknown): value is CollectorPairingState["state"] {
  return value === "paired" || value === "needs-pairing";
}

/** Read the persisted verdict, or null when absent or unreadable. */
export function readCollectorPairingState(configDir: string): CollectorPairingState | null {
  let raw: string;
  try {
    raw = readFileSync(statePath(configDir), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CollectorPairingState>;
    if (!isStateName(parsed.state)) return null;
    if (typeof parsed.deviceName !== "string" || typeof parsed.gatewayUrl !== "string") return null;
    if (typeof parsed.tokenFingerprint !== "string") return null;
    return {
      state: parsed.state,
      deviceName: parsed.deviceName,
      gatewayUrl: parsed.gatewayUrl,
      tokenFingerprint: parsed.tokenFingerprint,
      lastAuthenticatedAt:
        typeof parsed.lastAuthenticatedAt === "number" ? parsed.lastAuthenticatedAt : null,
      unauthorizedAt: typeof parsed.unauthorizedAt === "number" ? parsed.unauthorizedAt : null,
      repairCommand: typeof parsed.repairCommand === "string" ? parsed.repairCommand : null,
    };
  } catch {
    return null;
  }
}

/**
 * Persist a verdict. Best effort: a collector that cannot write its status
 * file still has a working gateway connection to report through, and a
 * collector that is locked out has already logged the reason.
 */
export function writeCollectorPairingState(
  configDir: string,
  state: CollectorPairingState,
): boolean {
  try {
    ensurePrivateDirSync(configDir);
    writeFileSync(statePath(configDir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the persisted record proves this exact credential, against this
 * exact gateway, authenticated at some point in the past.
 */
export function credentialEverAuthenticated(
  persisted: CollectorPairingState | null,
  input: { token: string; gatewayUrl: string },
): boolean {
  if (!persisted || persisted.lastAuthenticatedAt === null) return false;
  if (persisted.gatewayUrl !== input.gatewayUrl) return false;
  return persisted.tokenFingerprint === tokenFingerprint(input.token);
}

/**
 * What a probe of the gateway says about the collector's credential.
 *
 *   - `authenticated`: the gateway accepted it.
 *   - `needs-pairing`: the gateway did not recognise a credential that used
 *     to work — the device was revoked, and only re-pairing brings it back.
 *   - `never-authenticated`: unrecognised, with no history. The install was
 *     never wired up; retrying is the right move, because a half-finished
 *     pairing is usually finished by hand moments later.
 *   - `unreachable`: no answer, or an answer that says nothing about
 *     identity. Transient by assumption; the caller keeps retrying.
 *
 * Only 401 speaks to identity. A 403 means the gateway recognised the
 * credential and refused it on scope, so the device is still paired and a
 * repair code is not the fix; an authenticating proxy in front of the
 * gateway answers 403 too, and parking every collector behind one would be
 * the wrong call.
 */
export type CollectorAuthVerdict =
  | "authenticated"
  | "needs-pairing"
  | "never-authenticated"
  | "unreachable";

/**
 * Classify one probe result. `status` is the HTTP status the gateway
 * answered with, or null when the request never got an answer.
 */
export function classifyCollectorAuth(input: {
  status: number | null;
  everAuthenticated: boolean;
}): CollectorAuthVerdict {
  const { status, everAuthenticated } = input;
  if (status === null) return "unreachable";
  if (status === 401) {
    return everAuthenticated ? "needs-pairing" : "never-authenticated";
  }
  if (status >= 200 && status < 300) return "authenticated";
  return "unreachable";
}

/**
 * The command an operator runs on the gateway host to mint a repair code for
 * this collector. Bound to the device name because that is the only identity
 * the locked-out collector still knows.
 */
export function repairCommandFor(deviceName: string): string {
  return `omnesis devices repair ${deviceName}`;
}

/**
 * The single line a locked-out collector logs. One line, not a paragraph:
 * this is what an operator finds in `journalctl` weeks later, and it has to
 * carry the whole recovery on its own.
 */
export function needsPairingLogLine(input: {
  deviceName: string;
  gatewayUrl: string;
  configDir: string;
}): string {
  return (
    `Device "${input.deviceName}" is no longer paired with the gateway at ${input.gatewayUrl} ` +
    `(the gateway refused a credential that previously worked). ` +
    `On the gateway host run \`${repairCommandFor(input.deviceName)}\`, then here run ` +
    `\`omnesis pair <code> --gateway-url ${input.gatewayUrl} --save ${join(input.configDir, "collector-token")}\` ` +
    `and start the collector again.`
  );
}
