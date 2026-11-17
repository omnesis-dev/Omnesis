// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { CloudRelayManagementStatus } from "@omnesis/cloud-relay";

/**
 * Which of the gateway's addresses are still waiting for their publicly
 * trusted certificate. An address the gateway has just been given — its own
 * Tailscale device, or the name the Omnesis relay assigned it — serves the
 * gateway's own certificate, or nothing, for the minute it takes to obtain
 * the trusted one. An agent that requires a public certificate refuses it
 * meanwhile, and the Access page says to wait instead of telling the owner
 * to set up another certificate. A failed issuance is not pending.
 */
export interface CertificatePendingSources {
  /** The gateway's own Tailscale device, when it is wired (its feature flag is on). */
  tailscale?: {
    tailnetOrigin(): string | null;
    tailnetCertificatePending(): boolean;
  };
  /** The cloud relay's management, when it is wired (its feature flag is on). */
  relay?: { status(): Promise<CloudRelayManagementStatus> };
}

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Whether the relay is on and its public name's certificate has not been
 * issued yet: the gateway is still enrolling, or holds no certificate for
 * that name or only its placeholder one, and no attempt has failed.
 */
export function relayCertificatePending(status: CloudRelayManagementStatus): boolean {
  if (!status.enabled || status.certificate.lastError) return false;
  if (status.enrollment.state === "pending") return true;
  return (
    status.enrollment.state === "enrolled" &&
    (status.certificate.state === "unconfigured" || status.certificate.state === "bootstrap")
  );
}

/**
 * The origins whose trusted certificate is on its way right now. Resolved
 * once per overview, so every listed resource is judged against the same
 * moment.
 */
export async function pendingCertificateOrigins(
  sources: CertificatePendingSources,
): Promise<Set<string>> {
  const pending = new Set<string>();
  const tailnet = originOf(sources.tailscale?.tailnetOrigin());
  if (tailnet && sources.tailscale?.tailnetCertificatePending()) pending.add(tailnet);
  if (sources.relay) {
    const status = await sources.relay.status().catch(() => null);
    const origin = originOf(status?.publicOrigin);
    if (status && origin && relayCertificatePending(status)) pending.add(origin);
  }
  return pending;
}
