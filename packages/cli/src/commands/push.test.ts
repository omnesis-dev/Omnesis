// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  pushUnavailableLine,
  deliveryHealthLabel,
  formatDeliveryQueue,
  formatPushDeviceSummary,
  isPartialPushResult,
  pushCommand,
  relayApprovalLabel,
  resolvePushTestDevice,
} from "./push.js";

describe("push command surface", () => {
  test("is named push and exposes setup, status, and test", async () => {
    const meta = (await pushCommand.meta) as { name?: string; description?: string };
    expect(meta.name).toBe("push");
    expect(meta.description).toMatch(/push notifications/i);
    // Resolved before it is indexed. `subCommands` is declared `Resolvable`,
    // which is the definition, a thunk, or an async thunk — so the shape only
    // exists after whichever of those it is has been called.
    const declared = pushCommand.subCommands;
    const subCommands = await (typeof declared === "function" ? declared() : declared);
    expect(Object.keys(subCommands ?? {}).sort()).toEqual(["setup", "status", "test"]);
    expect(subCommands?.test).toHaveProperty("args.device");
  });

  test("resolves a push-test phone by exact id or unambiguous name", () => {
    const first = phone("00000000-0000-4000-8000-000000000001", "Primary phone");
    const second = phone("00000000-0000-4000-8000-000000000002", "Secondary phone");
    expect(resolvePushTestDevice([first, second], first.id)).toBe(first);
    expect(resolvePushTestDevice([first, second], second.name)).toBe(second);
    expect(() =>
      resolvePushTestDevice([first, { ...second, name: first.name }], first.name),
    ).toThrow(/More than one phone/);
    expect(() => resolvePushTestDevice([first], "missing-phone")).toThrow(/No paired phone/);
    expect(() => resolvePushTestDevice([{ ...first, transport: undefined }], first.id)).toThrow(
      /Update the gateway/,
    );
  });

  test("recognizes partial delivery without treating zero delivery as partial", () => {
    const result = {
      status: "exit-non-zero" as const,
      exitCode: 1,
      durationMs: 1,
      stdoutTail: "Wake accepted by 1/2 device(s).",
      stderrTail: "one unavailable",
      error: "notification wake failed for 1/2 device(s)",
      attempted: 2,
      delivered: 1,
    };
    expect(isPartialPushResult(result)).toBe(true);
    expect(isPartialPushResult({ ...result, delivered: 0 })).toBe(false);
    expect(isPartialPushResult({ ...result, delivered: 2 })).toBe(false);
  });

  test("renders actionable phone delivery-health diagnostics", () => {
    expect(deliveryHealthLabel("scheduled-summary")).toContain("batching notifications");
    expect(deliveryHealthLabel("permission-denied")).toMatch(/denied/);
    expect(deliveryHealthLabel("not-determined")).toMatch(/not been decided/);
    expect(deliveryHealthLabel("alerts-disabled")).toMatch(/disabled/);
    expect(deliveryHealthLabel("healthy")).toBe("healthy");
  });

  test("summarises the active phone transports", () => {
    expect(
      formatPushDeviceSummary({
        total: 4,
        directApns: 1,
        directFcm: 1,
        relay: 1,
        unavailable: 1,
      }),
    ).toBe("4 paired phone(s): 1 direct APNs, 1 direct FCM, 1 relay, 1 unavailable.");
  });

  test("reports relay authorization as a per-phone choice", () => {
    expect(relayApprovalLabel(0)).toBe("Relay approved on 0 phones");
    expect(relayApprovalLabel(1)).toBe("Relay approved on 1 phone");
    expect(relayApprovalLabel(2)).toBe("Relay approved on 2 phones");
  });

  test("renders every delivery-ledger state and timestamp", () => {
    expect(
      formatDeliveryQueue({
        pending: 2,
        leased: 1,
        delivered: 9,
        superseded: 3,
        expired: 4,
        lastClaimedAt: 1_700_000_000_000,
        lastDeliveredAt: null,
      }),
    ).toBe(
      "pending=2, leased=1, delivered=9, superseded=3, expired=4, " +
        "last claimed=2023-11-14T22:13:20.000Z, last delivered=never",
    );
  });

  test("renders durable wake attempts and terminal outcomes", () => {
    const rendered = formatDeliveryQueue({
      pending: 1,
      leased: 0,
      delivered: 4,
      superseded: 0,
      expired: 0,
      lastClaimedAt: null,
      lastDeliveredAt: null,
      wake: {
        pending: 1,
        leased: 0,
        sent: 3,
        terminal: 1,
        exhausted: 2,
        attempts: 9,
        lastAttemptAt: 1_700_000_000_000,
        lastSuccessAt: 1_699_999_000_000,
        lastOutcome: "exhausted",
        lastError: "relay wake failed",
        lastTransport: "relay",
      },
    });
    expect(rendered).toContain("wake attempts=9");
    expect(rendered).toContain("wake exhausted=2");
    expect(rendered).toContain("last wake outcome=exhausted");
    expect(rendered).toContain("last wake transport=relay");
    expect(rendered).toContain("last wake error=relay wake failed");
  });
});

function phone(id: string, name: string) {
  return {
    id,
    name,
    platform: "ios" as const,
    transport: "direct-apns" as const,
    status: "healthy" as const,
    updatedAt: 1,
    queue: {
      pending: 0,
      leased: 0,
      delivered: 0,
      superseded: 0,
      expired: 0,
      lastClaimedAt: null,
      lastDeliveredAt: null,
    },
  };
}

describe("pushUnavailableLine", () => {
  const phone = { id: "00000000-0000-4000-8000-000000000009", name: "Maya's phone" };

  test("missing relay consent is the phone owner's to give", () => {
    const line = pushUnavailableLine({
      ...phone,
      plan: { transport: "unavailable", reasonCode: "relay-disabled", reason: "not authorized" },
    });
    expect(line).toContain("approve them");
    expect(line).not.toContain("push setup");
  });

  test("an unsupported app identity needs direct credentials or the official app, never a relay URL", () => {
    const line = pushUnavailableLine({
      ...phone,
      plan: {
        transport: "unavailable",
        reasonCode: "no-direct-credential",
        reason: "no push credential covers dev.example.ios",
      },
    });
    expect(line).toContain("dev.example.ios");
    expect(line).toContain("omnesis push setup");
    expect(line).toContain("changing the relay URL does not authorize it");
  });

  test("an unavailable relay endpoint is the gateway's configuration", () => {
    const line = pushUnavailableLine({
      ...phone,
      plan: {
        transport: "unavailable",
        reasonCode: "relay-url-unavailable",
        reason: "relay URL is unavailable",
      },
    });
    expect(line).toContain("gateway.pushRelay.url");
  });

  test("a broken registration under a servable plan names the registration, not the credentials", () => {
    const line = pushUnavailableLine({
      ...phone,
      plan: { transport: "relay" },
      unavailableReason: "relay registration is incomplete",
    });
    expect(line).toContain("registration is broken (relay registration is incomplete)");
    expect(line).toContain("omnesis devices revoke");
    expect(line).not.toContain("push setup");
  });

  test("a phone-declared app id in the reason cannot steer the terminal", () => {
    const line = pushUnavailableLine({
      ...phone,
      plan: {
        transport: "unavailable",
        reasonCode: "no-direct-credential",
        reason: "no push credential covers dev.example\u001b[31m.evil",
      },
    });
    expect(line).not.toContain("\u001b");
  });

  test("an older gateway with neither plan nor reason gets the generic line", () => {
    expect(pushUnavailableLine(phone)).toContain("push transport unavailable");
  });
});
