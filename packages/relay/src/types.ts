// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export type RelayPlatform = "ios" | "android";

export type CarrierCredentialPruneReason =
  | "unregistered"
  | "bad_device_token"
  | "device_token_not_for_topic";

export type CarrierDispatchErrorKind = "credential_mint_failed" | "stale_credential" | "other";

export class CarrierDispatchError extends Error {
  readonly kind: CarrierDispatchErrorKind;
  readonly pruneReason: CarrierCredentialPruneReason | null;

  constructor(kind: Exclude<CarrierDispatchErrorKind, "stale_credential">);
  constructor(kind: "stale_credential", pruneReason: CarrierCredentialPruneReason);
  constructor(
    kind: CarrierDispatchErrorKind,
    pruneReason: CarrierCredentialPruneReason | null = null,
  ) {
    super(`carrier dispatch failed: ${kind}`);
    this.name = "CarrierDispatchError";
    this.kind = kind;
    this.pruneReason = pruneReason;
  }
}

export type RelayTarget =
  | {
      platform: "ios";
      token: string;
      appId: string;
      environment: "sandbox" | "production";
    }
  | {
      platform: "android";
      token: string;
      appId: string;
    };

export interface RelayCarrier {
  readonly platform: RelayPlatform;
  covers(appId: string): boolean;
  sendChallenge(target: RelayTarget, nonce: string): Promise<void>;
  sendWake(target: RelayTarget): Promise<void>;
  health(): CarrierHealth;
  dispose(): Promise<void>;
}

export interface CarrierHealth {
  configured: boolean;
  status: "unknown" | "reachable" | "unreachable";
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface RandomSource {
  bytes(length: number): Buffer;
  uuid(): string;
}
