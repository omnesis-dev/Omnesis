// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readPackageVersion } from "@omnesis/core";

import type {
  CarrierCredentialPruneReason,
  CarrierDispatchErrorKind,
  RelayPlatform,
} from "./types.js";

export type EnrolOutcome = "accepted" | "rejected" | "failed";
export type WakeResult = "sent" | "failed";
export type CarrierOutcome = "success" | "failure";
export type CarrierReason = "none" | CarrierDispatchErrorKind;
export type WakeRejectionReason =
  | "rate_limited"
  | "unknown_credential"
  | "bad_signature"
  | "unknown_identity";
export type AbuseEndpoint = "enrol" | "verify" | "wake";
export type AbuseRejectionReason =
  | "source_rate"
  | "carrier_failure_penalty"
  | "global_circuit"
  | "challenge_capacity"
  | "missing_source";

export interface RelayMetricStoreSnapshot {
  activeCredentials: Record<RelayPlatform, number>;
}

const VERSION = readPackageVersion(import.meta.url);
const LATENCY_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export class RelayMetrics {
  private readonly wakes = new Map<string, number>();
  private readonly enrolments = new Map<string, number>();
  private readonly carrierResults = new Map<string, number>();
  private readonly carrierLatencies = new Map<
    RelayPlatform,
    { buckets: number[]; sum: number; count: number }
  >();
  private readonly wakeRejections = new Map<WakeRejectionReason, number>();
  private readonly unanswered = new Map<RelayPlatform, number>();
  private readonly credentialMintFailures = new Map<RelayPlatform, number>();
  private readonly credentialsPruned = new Map<string, number>();
  private readonly abuseRejections = new Map<string, number>();

  wake(platform: RelayPlatform, result: WakeResult): void {
    increment(this.wakes, `${platform}|${result}`);
  }

  enrol(platform: RelayPlatform, outcome: EnrolOutcome): void {
    increment(this.enrolments, `${platform}|${outcome}`);
  }

  carrier(
    platform: RelayPlatform,
    outcome: CarrierOutcome,
    reason: CarrierReason,
    durationMs: number,
  ): void {
    increment(this.carrierResults, `${platform}|${outcome}|${reason}`);
    const seconds = Math.max(0, durationMs) / 1_000;
    const observations = this.carrierLatencies.get(platform) ?? {
      buckets: LATENCY_BUCKETS.map(() => 0),
      sum: 0,
      count: 0,
    };
    LATENCY_BUCKETS.forEach((bucket, index) => {
      if (seconds <= bucket) observations.buckets[index]! += 1;
    });
    observations.sum += seconds;
    observations.count += 1;
    this.carrierLatencies.set(platform, observations);
  }

  wakeRejected(reason: WakeRejectionReason): void {
    increment(this.wakeRejections, reason);
  }

  unansweredChallenge(platform: RelayPlatform, count: number): void {
    if (count > 0) this.unanswered.set(platform, (this.unanswered.get(platform) ?? 0) + count);
  }

  credentialMintFailure(platform: RelayPlatform): void {
    increment(this.credentialMintFailures, platform);
  }

  credentialPruned(platform: RelayPlatform, reason: CarrierCredentialPruneReason): void {
    increment(this.credentialsPruned, `${platform}|${reason}`);
  }

  abuseRejected(endpoint: AbuseEndpoint, reason: AbuseRejectionReason): void {
    increment(this.abuseRejections, `${endpoint}|${reason}`);
  }

  render(store: RelayMetricStoreSnapshot): string {
    const lines = [
      "# TYPE relay_build_info gauge",
      `relay_build_info{version=${label(VERSION)}} 1`,
      "# TYPE relay_active_credentials gauge",
      `relay_active_credentials{platform="ios"} ${store.activeCredentials.ios}`,
      `relay_active_credentials{platform="android"} ${store.activeCredentials.android}`,
      "# TYPE relay_wake_total counter",
      ...counterLines("relay_wake_total", this.wakes, ["platform", "result"]),
      "# TYPE relay_enrolments_total counter",
      ...counterLines("relay_enrolments_total", this.enrolments, ["platform", "outcome"]),
      "# TYPE relay_carrier_result_total counter",
      ...counterLines("relay_carrier_result_total", this.carrierResults, [
        "platform",
        "outcome",
        "reason",
      ]),
      "# TYPE relay_carrier_latency_seconds histogram",
      ...this.latencyLines(),
      "# TYPE relay_wake_rejected_total counter",
      ...simpleCounterLines("relay_wake_rejected_total", "reason", this.wakeRejections),
      "# TYPE relay_enrol_challenge_unanswered_total counter",
      ...simpleCounterLines("relay_enrol_challenge_unanswered_total", "platform", this.unanswered),
      "# TYPE relay_credential_mint_failures_total counter",
      ...simpleCounterLines(
        "relay_credential_mint_failures_total",
        "platform",
        this.credentialMintFailures,
      ),
      "# TYPE relay_credentials_pruned_total counter",
      ...counterLines("relay_credentials_pruned_total", this.credentialsPruned, [
        "platform",
        "reason",
      ]),
      "# TYPE relay_abuse_rejections_total counter",
      ...counterLines("relay_abuse_rejections_total", this.abuseRejections, ["endpoint", "reason"]),
    ];
    return `${lines.join("\n")}\n`;
  }

  private latencyLines(): string[] {
    const lines: string[] = [];
    for (const [platform, observations] of sorted(this.carrierLatencies)) {
      LATENCY_BUCKETS.forEach((bucket, index) => {
        lines.push(
          `relay_carrier_latency_seconds_bucket{platform=${label(platform)},le=${label(String(bucket))}} ${observations.buckets[index]}`,
        );
      });
      lines.push(
        `relay_carrier_latency_seconds_bucket{platform=${label(platform)},le="+Inf"} ${observations.count}`,
        `relay_carrier_latency_seconds_sum{platform=${label(platform)}} ${observations.sum}`,
        `relay_carrier_latency_seconds_count{platform=${label(platform)}} ${observations.count}`,
      );
    }
    return lines;
  }
}

function increment<K>(values: Map<K, number>, key: K): void {
  values.set(key, (values.get(key) ?? 0) + 1);
}

function counterLines(name: string, values: Map<string, number>, names: string[]): string[] {
  return sorted(values).map(([key, value]) => {
    const parts = key.split("|");
    const labels = names.map((labelName, index) => `${labelName}=${label(parts[index]!)}`);
    return `${name}{${labels.join(",")}} ${value}`;
  });
}

function simpleCounterLines<K extends string>(
  name: string,
  labelName: string,
  values: Map<K, number>,
): string[] {
  return sorted(values).map(([key, value]) => `${name}{${labelName}=${label(key)}} ${value}`);
}

function sorted<K extends string, T>(values: Map<K, T>): Array<[K, T]> {
  return [...values].sort(([left], [right]) => left.localeCompare(right));
}

function label(value: string): string {
  return JSON.stringify(value);
}
