// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { SourceType } from "@omnesis/types";

// A type the phone kind pushes, so the admin add path accepts the phone as its host.
const SOURCE_ID = "apple-health:local";
const MEMBER_SOURCE_ID = "apple-health:member-e2e";
const STALE_SOURCE_ID = "apple-health:stale-e2e";
const INITIAL_BACKOFF_MS = 500;

interface ClaimedDelivery {
  id: string;
  kind: string;
  targetId: string;
  affectedDeviceId?: string;
  sourceName?: string;
  affectedDeviceName?: string;
  title: string;
}

describe("mobile permission health durable notification flow", () => {
  let harness: SyntheticE2EHarness;
  let deviceId: string;
  let authToken: string;
  let claimantDeviceId: string;
  let claimantAuthToken: string;
  let checkedAt: number;
  let failNextWake = true;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      apnsBackend: "fake",
      fakeApnsOptions: {
        respond: () => {
          if (!failNextWake) return { statusCode: 200 };
          failNextWake = false;
          return { statusCode: 503, reason: "ServiceUnavailable" };
        },
      },
      extraGatewayConfig: {
        gateway: {
          mobilePermissionReminders: {
            initialDelay: `${INITIAL_BACKOFF_MS}ms`,
            multiplier: 2,
            maxDelay: "2s",
            reservationTtl: "100ms",
            scanInterval: "50ms",
          },
        },
      },
    });
    await harness.start();
    const appleHealthCapabilities = (installId: string) => ({
      platform: "ios",
      installId,
      hostableSourceTypes: ["apple-health" as SourceType],
      pushBasedSourceTypes: ["apple-health" as SourceType],
      multiDeviceModes: { "apple-health": "replicated" as const },
      replicaVersionPolicies: { "apple-health": "source-updated-at" as const },
      syncLease: true,
    });
    ({ deviceId, authToken } = await harness.registerFakeIosDevice(
      "Synthetic iOS device",
      appleHealthCapabilities("fictional-permission-health-owner"),
    ));
    ({ deviceId: claimantDeviceId, authToken: claimantAuthToken } =
      await harness.registerFakeIosDevice(
        "Synthetic claimant iOS device",
        appleHealthCapabilities("fictional-permission-health-member"),
      ));
    checkedAt = Date.now();
    await harness.gatewayJson("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        type: "apple-health",
        accountId: "local",
        deviceId,
        enabled: true,
      }),
    });
    await deviceJson(`/admin/devices/${deviceId}/push-health`, "POST", { status: "healthy" });
    await deviceJson(
      `/admin/devices/${claimantDeviceId}/push-health`,
      "POST",
      { status: "healthy" },
      claimantAuthToken,
    );
  }, 120_000);

  afterAll(async () => {
    await harness?.destroy();
  }, 15_000);

  test("covers delivery failure, durable retention, backoff, and recovery", async () => {
    // A delivery-disabled phone cannot retain or receive the reminder. The
    // failed attempt releases its reservation so a later report can retry.
    await deviceJson(`/admin/devices/${deviceId}/push-health`, "POST", {
      status: "permission-denied",
    });
    await deviceJson(
      `/admin/devices/${claimantDeviceId}/push-health`,
      "POST",
      { status: "permission-denied" },
      claimantAuthToken,
    );
    await report("background-access-missing");
    expect(harness.getApnsPushes()).toHaveLength(0);
    expect(await claimOrNull()).toBeNull();

    await deviceJson(`/admin/devices/${deviceId}/push-health`, "POST", { status: "healthy" });
    await deviceJson(
      `/admin/devices/${claimantDeviceId}/push-health`,
      "POST",
      { status: "healthy" },
      claimantAuthToken,
    );
    await report("background-access-missing");
    // The fake APNs endpoint rejects this wake with 503. The gateway still
    // retains the rendered notification, so foreground polling can claim it.
    await waitForApnsCount(2);
    expect(harness.getApnsPushes().length).toBeGreaterThanOrEqual(2);
    expect(failNextWake).toBe(false);
    const first = await claim();
    expect(first).toMatchObject({
      kind: "source-permission",
      targetId: SOURCE_ID,
      affectedDeviceId: deviceId,
    });
    expect(await confirm(first.id)).toBe(200);

    // A newer degraded report in the same episode does not bypass backoff.
    await report("permission-degraded");
    expect(await claimOrNull()).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, INITIAL_BACKOFF_MS + 100));
    await report("permission-degraded");
    const leased = await waitForClaim();
    expect(leased).toMatchObject({ affectedDeviceId: deviceId });

    await report("healthy");
    expect(await confirm(leased.id)).toBe(404);
    expect(await claimOrNull()).toBeNull();
  }, 30_000);

  test("tracks joined phones independently and ends a detached phone's episode", async () => {
    await harness.gatewayJson("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        type: "apple-health",
        accountId: "member-e2e",
        deviceId,
        enabled: true,
      }),
    });
    await harness.gatewayJson(`/admin/sources/${encodeURIComponent(MEMBER_SOURCE_ID)}/members`, {
      method: "POST",
      body: JSON.stringify({ deviceId: claimantDeviceId }),
    });

    checkedAt += 1;
    await deviceJson(
      `/admin/sources/${encodeURIComponent(MEMBER_SOURCE_ID)}/permission-health`,
      "PUT",
      {
        checkedAt,
        validForMs: 60_000,
        capabilities: [
          {
            id: "background-access",
            label: "Background access",
            state: "background-access-missing",
            requirement: "required",
            impact: "New records stop while the app is closed.",
            remediation: "Restore access in system Settings.",
            repairAction: "open-system-settings",
          },
        ],
      },
      claimantAuthToken,
    );

    const memberWarning = await claimOrNull(authToken);
    expect(memberWarning).toMatchObject({
      kind: "source-permission",
      targetId: MEMBER_SOURCE_ID,
      affectedDeviceId: claimantDeviceId,
      affectedDeviceName: "Synthetic claimant iOS device",
    });

    await harness.gatewayJson(
      `/admin/sources/${encodeURIComponent(MEMBER_SOURCE_ID)}/members/${claimantDeviceId}`,
      { method: "DELETE" },
    );
    expect(await claimOrNull()).toBeNull();
    const rejected = await deviceRequest(
      `/admin/sources/${encodeURIComponent(MEMBER_SOURCE_ID)}/permission-health`,
      "PUT",
      {
        checkedAt: checkedAt + 1,
        validForMs: 60_000,
        capabilities: [],
      },
      claimantAuthToken,
    );
    expect(rejected.status).toBe(403);

    // The remaining phone's independent row and authority survive the detach.
    await expect(reportFor(authToken, "healthy", 60_000, MEMBER_SOURCE_ID)).resolves.toBeDefined();
  }, 30_000);

  test("one fresh replica suppresses source-stale warnings until every phone is overdue", async () => {
    await harness.gatewayJson("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        type: "apple-health",
        accountId: "stale-e2e",
        deviceId,
        enabled: true,
      }),
    });
    await harness.gatewayJson(`/admin/sources/${encodeURIComponent(STALE_SOURCE_ID)}/members`, {
      method: "POST",
      body: JSON.stringify({ deviceId: claimantDeviceId }),
    });
    await reportFor(authToken, "healthy", 60_000, STALE_SOURCE_ID, Date.now() - 50_000);
    await reportFor(claimantAuthToken, "healthy", 60_000, STALE_SOURCE_ID, Date.now() - 57_000);

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await claimOrNull()).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const overdue = await waitForClaim();
    expect(overdue).toMatchObject({
      kind: "source-permission",
      targetId: STALE_SOURCE_ID,
      title: "Source check overdue",
    });

    await reportFor(authToken, "healthy", 60_000, STALE_SOURCE_ID);
    expect(await confirm(overdue.id)).toBe(404);
    await harness.gatewayJson(
      `/admin/sources/${encodeURIComponent(STALE_SOURCE_ID)}/members/${claimantDeviceId}`,
      { method: "DELETE" },
    );
  }, 30_000);

  async function report(state: "healthy" | "permission-degraded" | "background-access-missing") {
    return await reportFor(authToken, state, 60_000);
  }

  async function reportFor(
    token: string,
    state: "healthy" | "permission-degraded" | "background-access-missing",
    validForMs: number,
    sourceId = SOURCE_ID,
    observedAt?: number,
  ) {
    const reportCheckedAt = observedAt ?? (checkedAt += 1);
    return await deviceJson(
      `/admin/sources/${encodeURIComponent(sourceId)}/permission-health`,
      "PUT",
      {
        checkedAt: reportCheckedAt,
        validForMs,
        capabilities: [
          {
            id: "background-access",
            label: "Background access",
            state,
            requirement: "required",
            impact: "New records stop while the app is closed.",
            remediation: "Restore access in system Settings.",
            repairAction: state === "healthy" ? "none" : "open-system-settings",
          },
        ],
      },
      token,
    );
  }

  async function waitForClaim(token = claimantAuthToken): Promise<ClaimedDelivery> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const claimed = await claimOrNull(token);
      if (claimed) return claimed;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("timed out waiting for a durable permission notification");
  }

  async function waitForApnsCount(expected: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (harness.getApnsPushes().length >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${expected} fake APNs pushes`);
  }

  async function claim(): Promise<ClaimedDelivery> {
    const delivery = await claimOrNull();
    if (!delivery) throw new Error("expected a durable permission notification");
    return delivery;
  }

  async function claimOrNull(token = claimantAuthToken): Promise<ClaimedDelivery | null> {
    const response = await deviceRequest("/notifications/claim", "POST", {}, token);
    if (response.status === 204) return null;
    expect(response.status).toBe(200);
    return (await response.json()) as ClaimedDelivery;
  }

  async function confirm(id: string): Promise<number> {
    return (await deviceRequest("/notifications/confirm", "POST", { id }, claimantAuthToken))
      .status;
  }

  async function deviceJson(
    path: string,
    method: "POST" | "PUT",
    body: Record<string, unknown>,
    token = authToken,
  ): Promise<unknown> {
    const response = await deviceRequest(path, method, body, token);
    expect(response.status).toBe(200);
    return await response.json();
  }

  async function deviceRequest(
    path: string,
    method: "POST" | "PUT",
    body: Record<string, unknown>,
    token = authToken,
  ): Promise<Response> {
    return await fetch(`${harness.gatewayUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
});
