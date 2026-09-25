// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { RelayMetrics } from "./metrics.js";

describe("relay Prometheus metrics", () => {
  it("renders only the bounded operational metric contract", () => {
    const metrics = new RelayMetrics();
    metrics.enrol("ios", "accepted");
    metrics.wake("android", "sent");
    metrics.wakeRejected("rate_limited");
    metrics.carrier("ios", "success", "none", 125);
    metrics.unansweredChallenge("android", 2);
    metrics.credentialMintFailure("android");
    metrics.credentialPruned("ios", "bad_device_token");
    metrics.abuseRejected("enrol", "source_rate");

    const text = metrics.render({ activeCredentials: { ios: 3, android: 4 } });
    expect(text).toContain("relay_build_info{version=");
    expect(text).toContain('relay_active_credentials{platform="ios"} 3');
    expect(text).toContain('relay_enrolments_total{platform="ios",outcome="accepted"} 1');
    expect(text).toContain('relay_wake_total{platform="android",result="sent"} 1');
    expect(text).toContain('relay_wake_rejected_total{reason="rate_limited"} 1');
    expect(text).toContain(
      'relay_carrier_result_total{platform="ios",outcome="success",reason="none"} 1',
    );
    expect(text).toContain('relay_carrier_latency_seconds_bucket{platform="ios",le="0.25"} 1');
    expect(text).toContain('relay_enrol_challenge_unanswered_total{platform="android"} 2');
    expect(text).toContain('relay_credential_mint_failures_total{platform="android"} 1');
    expect(text).toContain(
      'relay_credentials_pruned_total{platform="ios",reason="bad_device_token"} 1',
    );
    expect(text).toContain('relay_abuse_rejections_total{endpoint="enrol",reason="source_rate"} 1');
    expect(text).not.toMatch(/credential_hash|nonce|app_id/);
    expect(text).not.toMatch(/connecting|source-a|127\.0\.0\.1/);
  });
});
