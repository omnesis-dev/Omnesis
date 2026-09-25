// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The served certificate, as the doctor reads it: expiry, the names it
 * misses, a replacement that could not be activated, and the phones that
 * may still pin a certificate the gateway no longer serves. Every remedy
 * names the command for the material's ownership, because a Tailscale
 * certificate, the gateway's own self-signed one and an operator's are
 * renewed by different hands.
 */

import { assertNever } from "../utils.js";
import type { TlsLifecycleSnapshot, TlsOwnership } from "../tls-material.js";

/** The subset of the evaluator's collector this module reports through. */
export interface TlsCheckSink {
  pass(section: string, id: string, message: string): void;
  warn(section: string, id: string, message: string, hint: string): void;
  fail(section: string, id: string, message: string, hint: string): void;
}

export interface TlsCheckDevice {
  name: string;
  kind: string;
  pairedAt?: number | null;
  lastSeenAt?: number | null;
  revokedAt?: number | null;
}

const GATEWAY = "Gateway";
const FLEET = "Fleet";
const PHONE_KINDS = new Set(["ios", "android"]);

function ownershipNoun(ownership: TlsOwnership): string {
  switch (ownership) {
    case "self-signed":
      return "the gateway's self-signed certificate";
    case "tailscale":
      return "the Tailscale certificate";
    case "mkcert":
      return "the mkcert certificate";
    case "external":
      return "the operator-managed certificate";
    default:
      return assertNever(ownership);
  }
}

/** How to get a new certificate served, for this material and renewal mode. */
function renewalRemedy(snapshot: TlsLifecycleSnapshot): string {
  const { renewal, ownership, certPath } = snapshot;
  const failed = renewal.lastError
    ? ` The last attempt (${renewal.lastAttemptAt ?? "unknown time"}) failed: ${renewal.lastError}.`
    : "";
  switch (renewal.mode) {
    case "automatic":
      return `The gateway renews it itself from ${renewal.renewBeforeDays} days before expiry and activates it without a restart; \`omnesis tls renew\` does it now.${failed}`;
    case "disabled":
      return `Automatic renewal is off (gateway.tls.autoRenew); run \`omnesis tls renew\` on the gateway host.${failed}`;
    case "host":
      return `This gateway runs in a container, so ${ownershipNoun(ownership)} is renewed on the host: re-run its issuer into ${certPath}, then \`omnesis tls reload\` (the gateway also picks it up within the hour).`;
    case "external":
      return `Renew it with the tool that issued it, keeping the paths in ${certPath}'s directory, then \`omnesis tls reload\` (the gateway also picks it up within the hour).`;
    default:
      return assertNever(renewal.mode);
  }
}

function namesRemedy(snapshot: TlsLifecycleSnapshot): string {
  switch (snapshot.ownership) {
    case "self-signed":
      return "Run `omnesis tls renew --force` on the gateway host to re-mint it with the host's current names; phones paired by fingerprint then need `omnesis devices repair <name>`.";
    case "tailscale":
    case "mkcert":
      return "Run `omnesis tls refresh` on the gateway host to re-provision it for the current names.";
    case "external":
      return "Issue a certificate that covers these names, then `omnesis tls reload`.";
    default:
      return assertNever(snapshot.ownership);
  }
}

function renewalRemedyAfterFailure(snapshot: TlsLifecycleSnapshot): string {
  switch (snapshot.ownership) {
    case "self-signed":
      return "Run `omnesis tls renew` on the gateway host and read its answer; the gateway retries every hour.";
    case "tailscale":
      return "Make sure `tailscale cert` works as the gateway's user (HTTPS enabled for the tailnet, the user set as the Tailscale operator), or run `omnesis tls refresh` on the gateway host; the gateway retries every hour.";
    case "mkcert":
      return "Make sure `mkcert` is on the gateway's PATH, or run `omnesis tls refresh` on the gateway host; the gateway retries every hour.";
    case "external":
      return "Renew it with the tool that issued it, then `omnesis tls reload`.";
    default:
      return assertNever(snapshot.ownership);
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function checkGatewayTls(
  snapshot: TlsLifecycleSnapshot | null | undefined,
  devices: ReadonlyArray<TlsCheckDevice> | null | undefined,
  ck: TlsCheckSink,
): void {
  if (!snapshot) return;
  const { served } = snapshot;
  const noun = ownershipNoun(snapshot.ownership);
  const pinned =
    " Phones paired by fingerprint stop connecting when it changes and need `omnesis devices repair <name>`; a collector or CLI host that refuses the new certificate needs `omnesis tls trust`.";

  switch (served.state) {
    case "valid":
      ck.pass(
        GATEWAY,
        "gateway.tls",
        `Serving ${noun}, valid until ${served.notAfter} (${served.daysRemaining} days)`,
      );
      break;
    case "expiring":
      ck.warn(
        GATEWAY,
        "gateway.tls",
        `${capitalize(noun)} expires in ${served.daysRemaining} days (${served.notAfter})`,
        renewalRemedy(snapshot),
      );
      break;
    case "expired":
      ck.fail(
        GATEWAY,
        "gateway.tls",
        `${capitalize(noun)} expired ${-(served.daysRemaining ?? 0)} days ago (${served.notAfter}); clients that verify it cannot connect`,
        renewalRemedy(snapshot) + pinned,
      );
      break;
    case "not-yet-valid":
      ck.fail(
        GATEWAY,
        "gateway.tls",
        `${capitalize(noun)} is not valid before ${served.notBefore}`,
        "Check the gateway host's clock; a certificate minted ahead of it is refused by every client until the clock catches up.",
      );
      break;
    case "unreadable":
    case "key-mismatch":
      ck.fail(
        GATEWAY,
        "gateway.tls",
        `${capitalize(noun)} could not be verified: ${served.error ?? served.state}`,
        renewalRemedy(snapshot),
      );
      break;
    default:
      assertNever(served.state);
  }

  if (served.uncoveredHosts.length > 0) {
    ck.warn(
      GATEWAY,
      "gateway.tls-names",
      `${capitalize(noun)} does not cover ${served.uncoveredHosts.join(", ")}; clients addressing the gateway by ${served.uncoveredHosts.length === 1 ? "that name" : "those names"} fail hostname verification`,
      namesRemedy(snapshot),
    );
  }

  if (snapshot.pendingReplacement) {
    ck.warn(
      GATEWAY,
      "gateway.tls-replacement",
      `A replacement certificate at ${snapshot.certPath} was not activated: ${snapshot.pendingReplacement.error}`,
      "The gateway keeps serving the previous certificate. Fix the pair on disk, then `omnesis tls reload`.",
    );
  }

  if (snapshot.renewal.lastError && (served.state === "valid" || served.state === "expiring")) {
    ck.warn(
      GATEWAY,
      "gateway.tls-renewal",
      `The last automatic renewal (${snapshot.renewal.lastAttemptAt ?? "unknown time"}) failed: ${snapshot.renewal.lastError}`,
      renewalRemedyAfterFailure(snapshot),
    );
  }

  // Only a self-signed certificate is ever pinned; a rotation of one issued
  // by a CA is verified by name, so it strands nobody.
  if (snapshot.rotation && devices && served.selfSigned) {
    const rotatedAt = Date.parse(snapshot.rotation.rotatedAt);
    const stranded = devices.filter(
      (device) =>
        PHONE_KINDS.has(device.kind) &&
        !device.revokedAt &&
        typeof device.pairedAt === "number" &&
        device.pairedAt < rotatedAt &&
        (device.lastSeenAt === null ||
          device.lastSeenAt === undefined ||
          device.lastSeenAt < rotatedAt),
    );
    if (stranded.length > 0) {
      const names = stranded.map((device) => device.name).join(", ");
      const one = stranded.length === 1;
      ck.warn(
        FLEET,
        "fleet.tls-pin-repair",
        `${stranded.length} phone${one ? "" : "s"} paired before the certificate rotated on ${snapshot.rotation.rotatedAt} ${one ? "has" : "have"} not connected since: ${names}`,
        `A phone that pinned the previous certificate cannot connect until it is paired again: \`omnesis devices repair ${one ? names : "<name>"}\`. One paired through system trust reconnects on its own and can be left alone.`,
      );
    }
  }
}
