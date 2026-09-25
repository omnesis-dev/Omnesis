// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  APNS_WAKE_JSON,
  APNS_WAKE_PAYLOAD,
  FCM_WAKE_DATA,
  PUSH_WAKE,
  PUBLISHED_PUSH_APP_IDS,
  PUBLISHED_PUSH_RELAY_URL,
  PUSH_RELAY_PROTOCOL_MAX_VERSION,
  PUSH_RELAY_PROTOCOL_MIN_VERSION,
  PUSH_RELAY_PROTOCOL_VERSION,
  notificationMessageSchema,
  claimedNotificationSchema,
  notificationDeliveryHealthReportSchema,
  notificationRoute,
  notificationTargetId,
  pushPlanRequestSchema,
  pushPlanSchema,
  pushRegistrationSchema,
  pushTransportSchema,
  pushWakeSchema,
  relayEnrolRequestSchema,
  relayVerifyRequestSchema,
  relayVerifyResponseSchema,
} from "./index.js";

describe("content-free carrier wakes", () => {
  test("the logical wake accepts only an empty object", () => {
    expect(pushWakeSchema.parse(PUSH_WAKE)).toEqual({});
    expect(() => pushWakeSchema.parse({ title: "Private title" })).toThrow();
    expect(() => pushWakeSchema.parse({ kind: "brief" })).toThrow();
  });

  test("pins exact constant carrier payloads", () => {
    expect(APNS_WAKE_JSON).toBe(
      '{"aps":{"alert":{"title":"Omnesis","body":"Omnesis has something for you"},"mutable-content":1,"sound":"default"}}',
    );
    expect(JSON.stringify(APNS_WAKE_PAYLOAD)).toBe(APNS_WAKE_JSON);
    expect(FCM_WAKE_DATA).toEqual({ wake: "1" });
    expect("title" in FCM_WAKE_DATA).toBe(false);
  });
});

describe("notification messages", () => {
  const cases = [
    { kind: "diagnostic", data: {}, targetId: "app" },
    { kind: "agent-answer", data: { conversationId: "conv_answer" }, targetId: "conv_answer" },
    { kind: "conversation", data: { conversationId: "conv_update" }, targetId: "conv_update" },
    { kind: "brief", data: { briefId: "brf_daily" }, targetId: "brf_daily" },
    {
      kind: "watch",
      data: { watchId: "watch_orders", firingKey: "fire_1" },
      targetId: "watch_orders",
    },
    { kind: "needs-auth", data: { sourceId: "fictional:account" }, targetId: "fictional:account" },
    {
      kind: "source-permission",
      data: { sourceId: "fictional-mobile:local", affectedDeviceId: "device-fictional" },
      targetId: "fictional-mobile:local",
    },
    {
      kind: "privacy-approval",
      data: { approvalId: "approval_fictional" },
      targetId: "approval_fictional",
    },
    { kind: "access-authorization", data: {}, targetId: "access" },
  ];

  test.each(cases)("accepts the $kind private notification variant", ({ kind, data, targetId }) => {
    const parsed = notificationMessageSchema.parse({
      kind,
      title: "Fictional notification",
      body: "Open Omnesis for the invented example.",
      data,
      collapseId: `${kind}:fictional`,
    });
    expect(parsed.kind).toBe(kind);
    expect(notificationTargetId(parsed)).toBe(targetId);
    expect(notificationRoute(parsed)).toEqual({ kind, ...data });
  });

  test("a watch firing carries the conversation the agent opened about it", () => {
    // The claim target stays the watch, so a client reading only that lands
    // exactly where it did before. The route is where the better landing is,
    // and it is the leg that never crosses a carrier.
    const parsed = notificationMessageSchema.parse({
      kind: "watch",
      title: "a-parcel-ships",
      body: "Your order shipped this morning.",
      data: { watchId: "watch_orders", firingKey: "fire_1", conversationId: "conv_firing" },
      collapseId: "watch:fire_1",
    });

    expect(notificationTargetId(parsed)).toBe("watch_orders");
    expect(notificationRoute(parsed)).toEqual({
      kind: "watch",
      watchId: "watch_orders",
      firingKey: "fire_1",
      conversationId: "conv_firing",
    });
  });

  test("claim context is optional for older rows and bounded when present", () => {
    const base = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "source-permission" as const,
      targetId: "fictional-mobile:local",
      title: "Source access needs attention",
      body: "Open the affected phone to repair access.",
      collapseId: "source-permission:fictional",
      remaining: 0,
    };
    expect(claimedNotificationSchema.parse(base).affectedDeviceId).toBeUndefined();
    expect(
      claimedNotificationSchema.parse({ ...base, affectedDeviceId: "device-fictional" }),
    ).toMatchObject({ affectedDeviceId: "device-fictional" });
    expect(() =>
      claimedNotificationSchema.parse({ ...base, affectedDeviceId: "x".repeat(257) }),
    ).toThrow();
  });

  test("rejects unknown producers and mismatched deep-link data", () => {
    expect(() =>
      notificationMessageSchema.parse({
        kind: "email",
        title: "Fictional notification",
        body: "Body",
        data: {},
        collapseId: "email:fictional",
      }),
    ).toThrow();
    expect(() =>
      notificationMessageSchema.parse({
        kind: "brief",
        title: "Fictional notification",
        body: "Body",
        data: { conversationId: "wrong-shape" },
        collapseId: "brief:fictional",
      }),
    ).toThrow();
  });
});

describe("push transport contracts", () => {
  test("accepts only normalized phone delivery-health reports", () => {
    expect(notificationDeliveryHealthReportSchema.parse({ status: "scheduled-summary" })).toEqual({
      status: "scheduled-summary",
    });
    expect(() => notificationDeliveryHealthReportSchema.parse({ status: "unknown" })).toThrow();
    expect(() =>
      notificationDeliveryHealthReportSchema.parse({ status: "healthy", detail: "private" }),
    ).toThrow();
  });

  test("recognises all four per-device transports", () => {
    for (const transport of ["direct-apns", "direct-fcm", "relay", "socket"]) {
      expect(pushTransportSchema.parse(transport)).toBe(transport);
    }
  });

  test("validates registrations without admitting socket as a registration", () => {
    const legacyRelayRegistration = {
      transport: "relay",
      relayUrl: "https://push.omnesis.app",
      credential: "relay_fictional",
    };
    expect(pushRegistrationSchema.parse(legacyRelayRegistration)).toMatchObject({
      transport: "relay",
    });
    expect(() =>
      pushRegistrationSchema.parse({ ...legacyRelayRegistration, appId: "dev.omnesis.ios" }),
    ).toThrow();
    expect(() => pushRegistrationSchema.parse({ transport: "socket" })).toThrow();
    for (const relayUrl of [
      "file:///tmp/relay.sock",
      "https://user:secret@push.example.com",
      "https://push.example.com/#fragment",
    ]) {
      expect(() =>
        pushRegistrationSchema.parse({
          transport: "relay",
          relayUrl,
          credential: "relay_fictional",
        }),
      ).toThrow();
    }
  });

  test("keeps unavailable as a plan outcome, not a transport", () => {
    expect(
      pushPlanSchema.parse({
        transport: "unavailable",
        reasonCode: "no-direct-credential",
        reason: "No matching credential",
      }),
    ).toMatchObject({ transport: "unavailable" });
    expect(() => pushTransportSchema.parse("unavailable")).toThrow();
  });

  test("accepts the exact platform and application identity plan contract", () => {
    expect(
      pushPlanRequestSchema.parse({
        platform: "android",
        appId: "dev.omnesis.android",
      }),
    ).toEqual({
      platform: "android",
      appId: "dev.omnesis.android",
    });
    expect(() =>
      pushPlanRequestSchema.parse({
        platform: "android",
        appId: "dev.omnesis.android",
        projectId: "must-not-cross-plan-boundary",
      }),
    ).toThrow();
  });

  test("pins the published app identities locally", () => {
    expect(PUBLISHED_PUSH_RELAY_URL).toBe("https://push.omnesis.app");
    expect(PUBLISHED_PUSH_APP_IDS).toEqual({
      ios: ["dev.omnesis.ios"],
      android: ["dev.omnesis.android"],
    });
  });

  test("requires platform-specific proof-of-possession enrolment facts", () => {
    expect(
      relayEnrolRequestSchema.parse({
        platform: "android",
        token: "fcm-token-fictional",
        appId: "dev.omnesis.android",
      }),
    ).toMatchObject({ platform: "android" });
    expect(() =>
      relayEnrolRequestSchema.parse({
        platform: "ios",
        token: "fcm-token-fictional",
        bundleId: "dev.omnesis.ios",
        environment: "production",
      }),
    ).toThrow();
  });

  test("pins relay protocol compatibility and bounded verify envelopes", () => {
    expect([
      PUSH_RELAY_PROTOCOL_MIN_VERSION,
      PUSH_RELAY_PROTOCOL_VERSION,
      PUSH_RELAY_PROTOCOL_MAX_VERSION,
    ]).toEqual([1, 1, 1]);
    expect(
      relayVerifyRequestSchema.parse({ challengeId: "challenge_fictional", nonce: "nonce" }),
    ).toEqual({ challengeId: "challenge_fictional", nonce: "nonce" });
    expect(relayVerifyResponseSchema.parse({ credential: "credential_fictional" })).toEqual({
      credential: "credential_fictional",
    });
    expect(() =>
      relayVerifyRequestSchema.parse({ challengeId: "challenge", nonce: "x".repeat(4097) }),
    ).toThrow();
  });
});
