// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  acquirePortalFleetUpdateRunnerClaim,
  updatePortalFleetUpdateOperation,
} from "@omnesis/core/portal-fleet-update";
import { HostFleetUpdateService } from "./HostFleetUpdateService.js";
import type { ReleaseCheckSnapshot } from "@omnesis/core/release-check";
import type { FleetUpdateService } from "./FleetUpdateService.js";
import type { PortalFleetUpdateLauncher } from "../../portal-fleet-update-launcher.js";

const RELEASE: ReleaseCheckSnapshot = {
  currentVersion: "1.4.0",
  latestVersion: "1.5.0",
  installMethod: "source",
  checkedAt: "2026-09-16T12:00:00.000Z",
  updateAvailable: true,
};
const OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000";

let configDir: string;
let release: ReleaseCheckSnapshot | null;
type Launch = PortalFleetUpdateLauncher["launch"];
let launch: ReturnType<typeof vi.fn<Launch>>;
let launcher: PortalFleetUpdateLauncher;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "omnesis-host-fleet-update-"));
  release = RELEASE;
  launch = vi.fn<Launch>(async () => undefined);
  launcher = {
    capability: () => ({ supported: true }),
    launch,
  };
});

function service(
  overrides: Partial<{
    launcher: PortalFleetUpdateLauncher;
    now: () => Date;
  }> = {},
) {
  const fleetUpdate = {
    plan: (targetVersion: string) => ({
      targetVersion,
      devices: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "Fictional collector",
          kind: "collector",
          version: "1.4.0",
          online: true,
          disposition: { kind: "update" as const },
          desiredVersion: null,
          updateState: null,
          updateDetail: null,
        },
      ],
    }),
  } as FleetUpdateService;
  return new HostFleetUpdateService({
    configDir,
    getReleaseCheck: () => release,
    fleetUpdate,
    launcher: overrides.launcher ?? launcher,
    now: overrides.now ?? (() => new Date("2026-09-16T12:01:00.000Z")),
    randomId: () => OPERATION_ID,
  });
}

describe("HostFleetUpdateService", () => {
  test("binds a reviewed future-version fleet plan to the successful release snapshot", () => {
    const plan = service().snapshot().plan!;
    expect(plan).toMatchObject({
      currentVersion: "1.4.0",
      targetVersion: "1.5.0",
      releaseCheckedAt: RELEASE.checkedAt,
      supported: true,
    });
    expect(plan.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.devices[0]).toMatchObject({ disposition: { kind: "update" } });
  });

  test("rejects a stale opaque plan before creating or launching anything", async () => {
    await expect(service().start("stale-plan")).rejects.toMatchObject({ status: 409 });
    expect(launch).not.toHaveBeenCalled();
    expect(service().snapshot().operation).toBeNull();
  });

  test("keeps unsupported topology explicit and disabled", async () => {
    const unsupported: PortalFleetUpdateLauncher = {
      capability: () => ({ supported: false, unsupportedReason: "Run `omnesis update --fleet`." }),
      launch,
    };
    const svc = service({ launcher: unsupported });
    const plan = svc.snapshot().plan!;
    expect(plan).toMatchObject({
      supported: false,
      unsupportedReason: expect.stringContaining("omnesis update --fleet"),
    });
    await expect(svc.start(plan.id)).rejects.toMatchObject({ status: 503 });
    expect(launch).not.toHaveBeenCalled();
  });

  test("writes the exact target durably before launch and returns one duplicate operation", async () => {
    const svc = service();
    const plan = svc.snapshot().plan!;
    const first = await svc.start(plan.id);
    const duplicate = await svc.start(plan.id);

    expect(first).toMatchObject({
      id: OPERATION_ID,
      currentVersion: "1.4.0",
      targetVersion: "1.5.0",
      state: "queued",
    });
    expect(duplicate.id).toBe(first.id);
    expect(launch).toHaveBeenCalledOnce();
  });

  test("serializes concurrent starts before launching the independent updater", async () => {
    let releaseLaunch: (() => void) | undefined;
    launch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseLaunch = resolve;
        }),
    );
    const firstService = service();
    const secondService = service();
    const planId = firstService.snapshot().plan!.id;

    const first = firstService.start(planId);
    const second = secondService.start(planId);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    await expect(second).resolves.toMatchObject({ id: OPERATION_ID, state: "queued" });
    releaseLaunch?.();
    await expect(first).resolves.toMatchObject({ id: OPERATION_ID, state: "queued" });
    expect(launch).toHaveBeenCalledOnce();
  });

  test("a replacement service reconstructs plan and progress with no release snapshot", async () => {
    const original = service();
    await original.start(original.snapshot().plan!.id);
    release = null;

    const recovered = service().snapshot();
    expect(recovered.operation).toMatchObject({ id: OPERATION_ID, state: "queued" });
    expect(recovered.plan).toMatchObject({
      currentVersion: "1.4.0",
      targetVersion: "1.5.0",
      devices: [expect.objectContaining({ name: "Fictional collector" })],
    });
  });

  test("records a bounded terminal failure when the manager refuses the launcher", async () => {
    launch.mockRejectedValueOnce(new Error(`manager refused ${"x".repeat(3_000)}`));
    const svc = service();
    const operation = await svc.start(svc.snapshot().plan!.id);
    expect(operation).toMatchObject({ state: "failed", completedAt: expect.any(String) });
    expect(operation.detail!.length).toBeLessThanOrEqual(2_048);
  });

  test("retries failed service-manager cleanup on a later status read", async () => {
    const cleanup = vi
      .fn<NonNullable<PortalFleetUpdateLauncher["cleanup"]>>()
      .mockRejectedValueOnce(new Error("temporary cleanup refusal"))
      .mockResolvedValueOnce(undefined);
    launch.mockRejectedValueOnce(new Error("manager refused the fictional job"));
    const svc = service({ launcher: { capability: () => ({ supported: true }), launch, cleanup } });
    await svc.start(svc.snapshot().plan!.id);
    expect(cleanup).toHaveBeenCalledOnce();

    svc.snapshot();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
    svc.snapshot();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  test("retains a failed attempt while exposing a fresh reviewed retry plan", async () => {
    launch.mockRejectedValueOnce(new Error("manager refused the fictional job"));
    const svc = service();
    const originalPlan = svc.snapshot().plan!;
    await svc.start(originalPlan.id);

    const retry = svc.snapshot();
    expect(retry.operation).toMatchObject({ state: "failed" });
    expect(retry.plan).toMatchObject({ id: originalPlan.id, supported: true });
    expect(retry.plan!.id).toMatch(/^[a-f0-9]{64}$/u);

    const retried = await svc.start(retry.plan!.id);
    expect(retried).toMatchObject({ state: "queued" });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["queued", "2026-09-16T11:58:00.000Z", "did not start"],
    ["running", "2026-09-16T09:59:00.000Z", "exited without recording"],
  ] as const)(
    "fails an orphaned %s operation so it can be retried",
    async (state, updatedAt, detail) => {
      const cleanup = vi.fn(async () => undefined);
      const guardedLauncher: PortalFleetUpdateLauncher = {
        capability: () => ({ supported: true }),
        launch,
        cleanup,
      };
      const svc = service({ launcher: guardedLauncher });
      const originalPlan = svc.snapshot().plan!;
      await svc.start(originalPlan.id);
      updatePortalFleetUpdateOperation(configDir, (operation) => ({
        ...operation,
        state,
        updatedAt,
        detail: "old detail",
      }));

      const recovered = svc.snapshot();
      expect(recovered.operation).toMatchObject({
        state: "failed",
        completedAt: "2026-09-16T12:01:00.000Z",
        detail: expect.stringContaining(detail),
      });
      expect(recovered.plan!.id).toBe(originalPlan.id);
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    },
  );

  test("does not expire an old running operation while its runner claim is live", async () => {
    const svc = service();
    const originalPlan = svc.snapshot().plan!;
    await svc.start(originalPlan.id);
    updatePortalFleetUpdateOperation(configDir, (operation) => ({
      ...operation,
      state: "running",
      updatedAt: "2026-09-16T01:00:00.000Z",
    }));
    const claim = acquirePortalFleetUpdateRunnerClaim(configDir);
    try {
      expect(svc.snapshot().operation).toMatchObject({ state: "running" });
    } finally {
      claim.release();
    }
  });

  test("retries only the remaining fleet when the gateway already serves the target", async () => {
    const svc = service();
    const originalPlan = svc.snapshot().plan!;
    await svc.start(originalPlan.id);
    updatePortalFleetUpdateOperation(configDir, (operation) => ({
      ...operation,
      state: "failed",
      updatedAt: "2026-09-16T12:02:00.000Z",
      completedAt: "2026-09-16T12:02:00.000Z",
      detail: "A fictional collector refused its command.",
    }));
    release = {
      currentVersion: "1.5.0",
      latestVersion: "1.5.0",
      installMethod: "source",
      checkedAt: "2026-09-16T12:03:00.000Z",
      updateAvailable: false,
    };

    const retry = svc.snapshot();
    expect(retry.operation).toMatchObject({ state: "failed" });
    expect(retry.plan).toMatchObject({
      currentVersion: "1.5.0",
      targetVersion: "1.5.0",
      supported: true,
    });
    expect(retry.plan!.id).toMatch(/^[a-f0-9]{64}$/u);
    await expect(svc.start(retry.plan!.id)).resolves.toMatchObject({
      currentVersion: "1.5.0",
      targetVersion: "1.5.0",
      state: "queued",
    });
  });

  test("does not expose an invalid retry when current gateway evidence is unavailable", async () => {
    launch.mockRejectedValueOnce(new Error("manager refused the fictional job"));
    const svc = service();
    await svc.start(svc.snapshot().plan!.id);
    release = null;

    const snapshot = svc.snapshot();
    expect(snapshot.operation).toMatchObject({ state: "failed" });
    expect(snapshot.plan).toMatchObject({
      id: `operation:${OPERATION_ID}`,
      supported: false,
      unsupportedReason: expect.stringContaining("Devices"),
    });
  });
});
