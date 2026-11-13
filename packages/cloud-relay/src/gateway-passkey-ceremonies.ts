// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import type { GatewayPasskeyPurpose } from "./device-enrollment.js";

/** How long a person has to finish the passkey prompt once the gateway issued its challenge. */
export const GATEWAY_PASSKEY_CHALLENGE_TTL_MS = 180_000;
const MAX_OUTSTANDING = 128;

/** Purposes whose challenge comes from this store; enrollment answers its request's own challenge. */
export type GatewayPasskeyCeremonyPurpose = Exclude<GatewayPasskeyPurpose, "device-enrollment">;

/**
 * One-use challenges for passkey ceremonies on the gateway's own page (`gateway-passkey`). Each
 * is issued for one purpose and one binding (what the assertion approves), and spent by the
 * first attempt to use it, whatever the outcome: an assertion over it can't be kept for later or
 * used for anything else. A device enrollment answers its request's `EnrollmentChallenges` value.
 */
export class GatewayPasskeyCeremonies {
  private readonly outstanding = new Map<
    string,
    { purpose: GatewayPasskeyCeremonyPurpose; binding: string; expiresAt: number }
  >();
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly limit = MAX_OUTSTANDING,
  ) {}

  issue(
    purpose: GatewayPasskeyCeremonyPurpose,
    binding: string,
  ): { challenge: string; expiresAt: number } {
    this.prune();
    // A flood may expire a waiting challenge, which only makes that person try again.
    while (this.outstanding.size >= this.limit)
      this.outstanding.delete(this.outstanding.keys().next().value as string);
    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + GATEWAY_PASSKEY_CHALLENGE_TTL_MS;
    this.outstanding.set(challenge, { purpose, binding, expiresAt });
    return { challenge, expiresAt };
  }

  /** Spends `challenge`; true only when it was issued for this purpose and binding and is live. */
  take(purpose: GatewayPasskeyCeremonyPurpose, challenge: string, binding: string): boolean {
    const entry = this.outstanding.get(challenge);
    this.outstanding.delete(challenge);
    return (
      entry !== undefined &&
      entry.purpose === purpose &&
      entry.binding === binding &&
      entry.expiresAt > this.now()
    );
  }

  private prune(): void {
    for (const [challenge, { expiresAt }] of this.outstanding)
      if (expiresAt <= this.now()) this.outstanding.delete(challenge);
  }
}
