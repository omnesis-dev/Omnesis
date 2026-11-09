// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { pairingCodeCommitment } from "./device-enrollment.js";

const TTL_MS = 120_000;
const MAX_OUTSTANDING = 256;

/**
 * One-use gateway challenges. A signature over one proves a live device key, not a captured request.
 * Each is also a commitment (`pairingCodeCommitment`) to a nonce only this gateway knows until
 * the challenge is spent, which is what lets a pairing request's comparison code be short.
 */
export class EnrollmentChallenges {
  private readonly outstanding = new Map<string, { nonce: string; expiresAt: number }>();
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly limit = MAX_OUTSTANDING,
  ) {}

  issue(): { challenge: string; expiresAt: number } {
    this.prune();
    // A flood may expire a waiting challenge, which only makes that device ask again.
    while (this.outstanding.size >= this.limit) {
      const oldest = this.outstanding.keys().next().value as string;
      this.outstanding.delete(oldest);
    }
    const nonce = randomBytes(32).toString("base64url");
    const challenge = pairingCodeCommitment(nonce);
    const expiresAt = this.now() + TTL_MS;
    this.outstanding.set(challenge, { nonce, expiresAt });
    return { challenge, expiresAt };
  }

  /** Spends a challenge and returns the nonce it committed to. */
  take(challenge: string): string | undefined {
    const entry = this.outstanding.get(challenge);
    this.outstanding.delete(challenge);
    return entry && entry.expiresAt > this.now() ? entry.nonce : undefined;
  }

  consume(challenge: string): boolean {
    return this.take(challenge) !== undefined;
  }

  private prune(): void {
    for (const [challenge, { expiresAt }] of this.outstanding)
      if (expiresAt <= this.now()) this.outstanding.delete(challenge);
  }
}
