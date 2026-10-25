// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a paired device will stop connecting, or already has, because it
 * trusts one exact certificate that the gateway replaces.
 *
 * A client pinned to the served leaf (a phone paired by fingerprint to an
 * address no public authority vouches for, an agent connected to a
 * self-signed gateway) cannot follow a renewal: the new certificate has a
 * new key. A client that verifies the gateway's name through public roots
 * follows it untouched. Devices report which they do in their hello
 * (`capabilities.tls`).
 *
 * An agent integration checks the exact leaf under any pin, so its
 * `pinned-ca` — a pinned certificate that could also act as an issuer —
 * strands at a renewal exactly like `pinned-leaf`. One that reports
 * `followsPublicRenewal` gives its pin up for public trust when a publicly
 * trusted certificate replaces it, so a renewal of the gateway's Tailscale
 * certificate leaves it connected. A managed harness that reports no mode at
 * all runs an integration from before devices reported trust, which always
 * pins the leaf; it is warned about ahead of a renewal like a declared pin,
 * with the update that lets it follow one. Any other device that does not
 * report its mode is judged only once a rotation has actually happened and it
 * has been silent since. Derived on every read, never stored.
 */

import type { DeviceTlsTrustMode } from "@omnesis/types";
import type { TlsLifecycleSnapshot } from "./tls-material.js";

export interface TlsTrustDeviceFacts {
  name: string;
  kind: string;
  /** The agent harness, for an `agent` device; it names the repair command. */
  harness?: string | null;
  tlsMode?: DeviceTlsTrustMode | null;
  /** The device reported that its pin gives way to public trust at a publicly trusted renewal. */
  tlsFollowsPublicRenewal?: boolean;
  pairedAt?: number | null;
  lastSeenAt?: number | null;
  revokedAt?: number | null;
}

export type DeviceTlsTrust =
  /**
   * Pins the served certificate, which the gateway replaces at `renewsAt`, so
   * it loses its connection then. `updateFollows` marks an integration that an
   * update made before then lets follow the renewal instead.
   */
  | { status: "pinned-renews"; renewsAt: string; remedy: string; updateFollows?: true }
  /** Paired before the certificate it may pin was replaced, and silent since. */
  | { status: "stranded"; rotatedAt: string; remedy: string };

export type TlsTrustSnapshotFacts = Pick<
  TlsLifecycleSnapshot,
  "ownership" | "served" | "rotation" | "renewsAt"
>;

const KNOWN_MODES: ReadonlySet<string> = new Set<DeviceTlsTrustMode>([
  "system",
  "pinned-leaf",
  "pinned-ca",
  "legacy",
]);

function reportedTls(capabilities: unknown): Record<string, unknown> | null {
  if (!capabilities || typeof capabilities !== "object") return null;
  const tls = (capabilities as { tls?: unknown }).tls;
  return tls && typeof tls === "object" ? (tls as Record<string, unknown>) : null;
}

/**
 * The trust mode a device's capabilities report, or null when it reports
 * none or one this gateway does not know. The wire accepts any short string
 * so a newer client's mode never fails its hello; this is where it narrows.
 */
export function deviceTlsTrustMode(capabilities: unknown): DeviceTlsTrustMode | null {
  const mode = reportedTls(capabilities)?.mode;
  return typeof mode === "string" && KNOWN_MODES.has(mode) ? (mode as DeviceTlsTrustMode) : null;
}

/**
 * Whether a device's capabilities report that its pin gives way to public
 * trust when a publicly trusted certificate replaces it. Only an explicit
 * `true` counts.
 */
export function deviceTlsFollowsPublicRenewal(capabilities: unknown): boolean {
  return reportedTls(capabilities)?.followsPublicRenewal === true;
}

const isPhone = (kind: string): boolean => kind === "ios" || kind === "android";

/** A managed agent harness (OpenClaw, Hermes), whose integration is what pins. */
const isManagedHarness = (device: TlsTrustDeviceFacts): boolean =>
  device.kind === "agent" && Boolean(device.harness);

/**
 * Whether a reported mode pins the served leaf. `pinned-ca` does only on an
 * agent, whose integration checks the leaf under any pin; no other client
 * reports it.
 */
function reportsLeafPin(device: TlsTrustDeviceFacts, mode: DeviceTlsTrustMode | null): boolean {
  return mode === "pinned-leaf" || (mode === "pinned-ca" && device.kind === "agent");
}

/**
 * Whether a device that does not report its trust mode may pin: a phone, or
 * a managed agent harness. Other agent devices connect through a client that
 * verifies by name and never pins.
 */
function mayPinUnreported(device: TlsTrustDeviceFacts): boolean {
  return isPhone(device.kind) || isManagedHarness(device);
}

/** What brings back a device that pinned a certificate the gateway already replaced. */
function strandedRemedy(device: TlsTrustDeviceFacts, fingerprintSha256: string | null): string {
  if (device.kind === "agent") {
    const harness = device.harness ?? "<harness>";
    // The new fingerprint lets the refresh accept the certificate unattended.
    const pin = fingerprintSha256 ? ` --trust-fingerprint sha256:${fingerprintSha256}` : "";
    return `On the machine running it: \`omnesis connect ${harness} --refresh${pin}\`.`;
  }
  if (isPhone(device.kind)) {
    const repair = `\`omnesis devices repair ${device.name}\``;
    // A current app that reports its pin is pinned because its address has no
    // public trust; only pairing again replaces the pin. An app that does not
    // report one may predate following renewals, which updating it fixes.
    return device.tlsMode
      ? `Pair it again: ${repair}.`
      : `Update the app and open it, or pair it again: ${repair}.`;
  }
  return "On that machine: `omnesis tls trust`.";
}

/**
 * What keeps a device that pins the served certificate connected across the
 * coming renewal. Nothing run before the renewal can trust a certificate that
 * does not exist yet, so the remedy is to verify by name instead, to update an
 * integration that predates following renewals, or to repair once the renewal
 * has happened.
 */
function renewalRemedy(device: TlsTrustDeviceFacts, updateFollows: boolean): string {
  if (device.kind === "agent") {
    // Without the fingerprint the stranded remedy carries: it does not exist yet.
    const refresh = `\`omnesis connect ${device.harness ?? "<harness>"} --refresh\``;
    if (updateFollows) {
      return `Update it before then (Update device on its card, or \`omnesis update --fleet\`): an updated integration that reaches the gateway by its Tailscale name follows the renewal. Otherwise, after the renewal, on the machine running it: ${refresh}.`;
    }
    return `Connect it by the gateway's Tailscale or domain name to follow renewals; otherwise, after the renewal, on the machine running it: ${refresh}.`;
  }
  if (isPhone(device.kind)) {
    return `Pair it again by the gateway's Tailscale or domain name to follow renewals; otherwise it needs \`omnesis devices repair ${device.name}\` after the renewal.`;
  }
  return "After the renewal, run `omnesis tls trust` on that machine.";
}

export function deviceTlsTrust(
  device: TlsTrustDeviceFacts,
  snapshot: TlsTrustSnapshotFacts | null | undefined,
): DeviceTlsTrust | null {
  if (!snapshot || device.revokedAt) return null;
  const mode = device.tlsMode ?? null;
  const declaredPinned = reportsLeafPin(device, mode);
  // `legacy` pairings carry no fingerprint and verify through the platform's
  // own trust, exactly like `system`; any other client's pinned authority
  // signs every renewal.
  if (mode !== null && !declaredPinned) return null;

  const rotation = snapshot.rotation;
  if (rotation && (declaredPinned || mayPinUnreported(device))) {
    const rotatedAt = Date.parse(rotation.rotatedAt);
    const pairedBefore = typeof device.pairedAt === "number" && device.pairedAt < rotatedAt;
    const silentSince =
      device.lastSeenAt === null ||
      device.lastSeenAt === undefined ||
      device.lastSeenAt < rotatedAt;
    if (pairedBefore && silentSince) {
      return {
        status: "stranded",
        rotatedAt: rotation.rotatedAt,
        remedy: strandedRemedy(device, snapshot.served.fingerprintSha256),
      };
    }
  }

  if (!snapshot.renewsAt) return null;
  // Only a Tailscale certificate verifies under public roots; renewing any
  // other leaves a pin nothing to give way to.
  const publiclyTrusted = snapshot.ownership === "tailscale";
  if (declaredPinned) {
    if (publiclyTrusted && device.tlsFollowsPublicRenewal) return null;
    return {
      status: "pinned-renews",
      renewsAt: snapshot.renewsAt,
      remedy: renewalRemedy(device, false),
    };
  }
  // A harness that reports no mode runs an integration from before devices
  // reported trust, and every one of those pins the leaf. Any other device
  // that does not report its mode may verify by name, so it is not warned
  // about ahead of time.
  if (isManagedHarness(device)) {
    return {
      status: "pinned-renews",
      renewsAt: snapshot.renewsAt,
      remedy: renewalRemedy(device, publiclyTrusted),
      ...(publiclyTrusted ? { updateFollows: true as const } : {}),
    };
  }
  return null;
}
