// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Portal authority for updating the gateway host and then its fleet.
 *
 * The browser receives an opaque plan id bound to the gateway's last
 * successful release snapshot. Starting accepts only that id. The exact
 * stable target is copied into an owner-only operation record before a
 * service-manager-owned runner is launched, so the replacement gateway can
 * resume the same operation view after this process stops.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  isStableReleaseVersion,
  compareStableReleaseVersions,
  type ReleaseCheckSnapshot,
} from "@omnesis/core/release-check";
import {
  acquirePortalFleetUpdateRunnerClaim,
  createPortalFleetUpdateOperation,
  readPortalFleetUpdateOperation,
  updatePortalFleetUpdateOperation,
  type PortalFleetUpdateOperation,
} from "@omnesis/core/portal-fleet-update";
import { UpdateLockBusyError } from "@omnesis/core";
import { ConflictError, ServiceUnavailableError } from "../errors.js";
import type { FleetUpdatePlan } from "@omnesis/core";
import type { FleetUpdateService } from "./FleetUpdateService.js";
import type {
  PortalFleetUpdateCapability,
  PortalFleetUpdateLauncher,
} from "../../portal-fleet-update-launcher.js";

export interface HostFleetUpdatePlan extends FleetUpdatePlan {
  id: string;
  currentVersion: string;
  targetVersion: string;
  releaseCheckedAt: string;
  supported: boolean;
  unsupportedReason?: string;
}

export interface HostFleetUpdateSnapshot {
  plan: HostFleetUpdatePlan | null;
  operation: PortalFleetUpdateOperation | null;
}

export interface HostFleetUpdateServiceOptions {
  configDir: string;
  getReleaseCheck(): ReleaseCheckSnapshot | null;
  fleetUpdate: FleetUpdateService;
  launcher: PortalFleetUpdateLauncher;
  now?: () => Date;
  randomId?: () => string;
}

function planId(release: ReleaseCheckSnapshot): string {
  return createHash("sha256")
    .update("omnesis:portal-fleet-update-plan:v1\0", "utf8")
    .update(
      JSON.stringify([
        release.currentVersion,
        release.latestVersion,
        release.installMethod,
        release.checkedAt,
      ]),
      "utf8",
    )
    .digest("hex");
}

function validRelease(release: ReleaseCheckSnapshot | null): release is ReleaseCheckSnapshot {
  return Boolean(
    release?.updateAvailable &&
    isStableReleaseVersion(release.currentVersion) &&
    isStableReleaseVersion(release.latestVersion) &&
    compareStableReleaseVersions(release.currentVersion, release.latestVersion) === -1 &&
    Number.isFinite(Date.parse(release.checkedAt)),
  );
}

function active(operation: PortalFleetUpdateOperation | null): boolean {
  return operation?.state === "queued" || operation?.state === "running";
}

const QUEUED_STALE_MS = 2 * 60 * 1_000;

function retryPlanId(operation: PortalFleetUpdateOperation, release: ReleaseCheckSnapshot): string {
  return createHash("sha256")
    .update("omnesis:portal-fleet-update-retry:v1\0", "utf8")
    .update(JSON.stringify([operation.id, operation.targetVersion, release.checkedAt]), "utf8")
    .digest("hex");
}

export class HostFleetUpdateService {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly cleanedOperations = new Set<string>();
  private readonly cleanupInFlight = new Set<string>();

  constructor(private readonly options: HostFleetUpdateServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
  }

  snapshot(): HostFleetUpdateSnapshot {
    const recordedOperation = this.reconcileOperation();
    const releasePlan = this.releasePlan();
    const retryPlan =
      !releasePlan && recordedOperation?.state === "failed"
        ? this.retryPlan(recordedOperation)
        : null;
    // A completed operation must not cover a later release notice forever.
    // Keep its final result until the checker advertises a different target;
    // that newer reviewed transition then becomes the portal's current work.
    const operation =
      recordedOperation &&
      (!releasePlan ||
        active(recordedOperation) ||
        recordedOperation.targetVersion === releasePlan.targetVersion)
        ? recordedOperation
        : null;
    // Once the update lands, the release checker correctly stops advertising
    // that target. Rebuild the reviewed plan from the durable record so a
    // reload still names every device's queued/refused/manual final state.
    const operationPlan = operation ? this.operationPlan(operation) : null;
    return {
      // A failed attempt must retain its diagnostics while still exposing the
      // newly reviewed release plan as the only valid retry authority.
      plan:
        operation?.state === "failed"
          ? (releasePlan ?? retryPlan ?? operationPlan)
          : (operationPlan ?? releasePlan),
      operation,
    };
  }

  private reconcileOperation(): PortalFleetUpdateOperation | null {
    let operation = readPortalFleetUpdateOperation(this.options.configDir);
    if (operation && active(operation)) {
      const operationId = operation.id;
      const age = this.now().getTime() - Date.parse(operation.updatedAt);
      if (!Number.isFinite(age) || age > QUEUED_STALE_MS) {
        let claim;
        try {
          claim = acquirePortalFleetUpdateRunnerClaim(this.options.configDir);
        } catch (error) {
          if (error instanceof UpdateLockBusyError) return operation;
          throw error;
        }
        const completedAt = this.now().toISOString();
        try {
          operation = updatePortalFleetUpdateOperation(this.options.configDir, (current) => {
            if (current.id !== operationId || !active(current)) return current;
            return {
              ...current,
              state: "failed",
              updatedAt: completedAt,
              completedAt,
              detail:
                current.state === "queued"
                  ? "The host updater did not start. Review the plan and retry."
                  : "The host updater exited without recording a result. Inspect the output, then retry.",
            };
          });
        } finally {
          claim.release();
        }
      }
    }
    if (operation && !active(operation) && !this.cleanedOperations.has(operation.id)) {
      void this.cleanupOperation(operation.id).catch(() => undefined);
    }
    return operation;
  }

  private async cleanupOperation(operationId: string): Promise<void> {
    if (this.cleanedOperations.has(operationId) || this.cleanupInFlight.has(operationId)) return;
    this.cleanupInFlight.add(operationId);
    try {
      await this.options.launcher.cleanup?.({
        operationId,
        configDir: this.options.configDir,
      });
      this.cleanedOperations.add(operationId);
    } finally {
      this.cleanupInFlight.delete(operationId);
    }
  }

  private releasePlan(): HostFleetUpdatePlan | null {
    const release = this.options.getReleaseCheck();
    if (!validRelease(release)) return null;
    return this.buildPlan({
      id: planId(release),
      currentVersion: release.currentVersion,
      targetVersion: release.latestVersion,
      releaseCheckedAt: release.checkedAt,
      capability: this.options.launcher.capability(release),
    });
  }

  private operationPlan(operation: PortalFleetUpdateOperation): HostFleetUpdatePlan {
    return this.buildPlan({
      id: `operation:${operation.id}`,
      currentVersion: operation.currentVersion,
      targetVersion: operation.targetVersion,
      releaseCheckedAt: operation.releaseCheckedAt,
      capability:
        operation.state === "failed"
          ? {
              supported: false,
              unsupportedReason:
                "No safe retry plan is available. Retry failed device updates from Devices.",
            }
          : { supported: true },
    });
  }

  private retryPlan(operation: PortalFleetUpdateOperation): HostFleetUpdatePlan | null {
    const release = this.options.getReleaseCheck();
    if (
      !release ||
      !isStableReleaseVersion(release.currentVersion) ||
      release.currentVersion !== operation.targetVersion ||
      !Number.isFinite(Date.parse(release.checkedAt))
    ) {
      return null;
    }
    return this.buildPlan({
      id: retryPlanId(operation, release),
      currentVersion: release.currentVersion,
      targetVersion: operation.targetVersion,
      releaseCheckedAt: release.checkedAt,
      capability: this.options.launcher.capability(release, { allowCurrentTarget: true }),
    });
  }

  private buildPlan(input: {
    id: string;
    currentVersion: string;
    targetVersion: string;
    releaseCheckedAt: string;
    capability: PortalFleetUpdateCapability;
  }): HostFleetUpdatePlan {
    const fleet = this.options.fleetUpdate.plan(input.targetVersion);
    return {
      id: input.id,
      currentVersion: input.currentVersion,
      targetVersion: input.targetVersion,
      releaseCheckedAt: input.releaseCheckedAt,
      supported: input.capability.supported,
      ...(input.capability.unsupportedReason
        ? { unsupportedReason: input.capability.unsupportedReason }
        : {}),
      devices: fleet.devices,
    };
  }

  async start(requestedPlanId: string): Promise<PortalFleetUpdateOperation> {
    const existing = readPortalFleetUpdateOperation(this.options.configDir);
    const plan =
      this.releasePlan() ?? (existing?.state === "failed" ? this.retryPlan(existing) : null);
    if (!plan || plan.id !== requestedPlanId) {
      throw new ConflictError(
        "The release plan changed. Review the current transition and try again.",
      );
    }
    if (!plan.supported) {
      throw new ServiceUnavailableError(
        plan.unsupportedReason ?? "This gateway cannot start its own fleet update.",
      );
    }

    if (active(existing)) {
      if (existing!.targetVersion === plan.targetVersion) return existing!;
      throw new ConflictError("Another gateway host update is already running.");
    }

    const timestamp = this.now().toISOString();
    const proposed: PortalFleetUpdateOperation = {
      id: this.randomId(),
      currentVersion: plan.currentVersion,
      targetVersion: plan.targetVersion,
      releaseCheckedAt: plan.releaseCheckedAt,
      state: "queued",
      startedAt: timestamp,
      updatedAt: timestamp,
      detail: "Waiting for the gateway host updater to start.",
    };
    const created = createPortalFleetUpdateOperation(this.options.configDir, proposed);
    const operation = created.operation;
    if (!created.created) {
      if (operation.targetVersion === plan.targetVersion) return operation;
      throw new ConflictError("Another gateway host update is already running.");
    }

    try {
      await this.options.launcher.launch({
        operationId: operation.id,
        configDir: this.options.configDir,
      });
    } catch (error) {
      const completedAt = this.now().toISOString();
      let managerRefused = false;
      const failed = updatePortalFleetUpdateOperation(this.options.configDir, (current) => {
        // A runner that already moved the record owns it. This branch is only
        // the service manager refusing to create the independent job.
        if (current.id !== operation.id || current.state !== "queued") return current;
        managerRefused = true;
        return {
          ...current,
          state: "failed",
          updatedAt: completedAt,
          completedAt,
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 2_048),
        };
      });
      if (managerRefused) {
        await this.cleanupOperation(operation.id).catch(() => undefined);
      }
      return failed;
    }
    return readPortalFleetUpdateOperation(this.options.configDir) ?? operation;
  }
}
