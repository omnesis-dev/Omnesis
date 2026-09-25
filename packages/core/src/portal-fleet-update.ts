// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Durable state shared by the portal host-update launcher and the gateway
 * process that replaces itself during the update. The record contains no
 * command line or environment: the launcher learns only the approved stable
 * release from here and constructs its command internally.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteFileSync } from "./atomic-write.js";
import { compareStableReleaseVersions, isStableReleaseVersion } from "./release-check.js";
import { acquireUpdateLock, type UpdateLock } from "./update-lock.js";

export const PORTAL_FLEET_UPDATE_OPERATION_FILE = "portal-fleet-update.json";
export const PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES = 16 * 1024;
export const PORTAL_FLEET_UPDATE_DETAIL_MAX_LENGTH = 2_048;

export type PortalFleetUpdateState = "queued" | "running" | "succeeded" | "failed";

export interface PortalFleetUpdateOperation {
  readonly id: string;
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly releaseCheckedAt: string;
  state: PortalFleetUpdateState;
  readonly startedAt: string;
  updatedAt: string;
  completedAt?: string;
  detail?: string;
  output?: string;
}

const operationSchema = z
  .object({
    id: z.string().uuid(),
    currentVersion: z.string().refine(isStableReleaseVersion, "expected an exact stable release"),
    targetVersion: z.string().refine(isStableReleaseVersion, "expected an exact stable release"),
    releaseCheckedAt: z.string().datetime({ offset: true }),
    state: z.enum(["queued", "running", "succeeded", "failed"]),
    startedAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).optional(),
    detail: z.string().max(PORTAL_FLEET_UPDATE_DETAIL_MAX_LENGTH).optional(),
    output: z.string().optional(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    if (compareStableReleaseVersions(operation.currentVersion, operation.targetVersion) === 1) {
      ctx.addIssue({
        code: "custom",
        path: ["targetVersion"],
        message: "target version cannot be older than current version",
      });
    }
    const terminal = operation.state === "succeeded" || operation.state === "failed";
    if (terminal !== (operation.completedAt !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: terminal
          ? "terminal operations require completedAt"
          : "non-terminal operations cannot have completedAt",
      });
    }
    if (
      operation.output !== undefined &&
      Buffer.byteLength(operation.output, "utf8") > PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["output"],
        message: `output exceeds ${PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES} bytes`,
      });
    }
  });

/** Fixed location under the installation's private configuration directory. */
export function portalFleetUpdateOperationPath(configDir: string): string {
  return join(configDir, PORTAL_FLEET_UPDATE_OPERATION_FILE);
}

/**
 * Retain only the newest diagnostic bytes. Chunk boundaries may split one
 * UTF-8 character, so discard the replacement marker produced at that one
 * possible boundary rather than persisting malformed text.
 */
export function portalFleetUpdateOutputTail(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES) return output;
  return bytes
    .subarray(bytes.length - PORTAL_FLEET_UPDATE_OUTPUT_MAX_BYTES)
    .toString("utf8")
    .replace(/^\uFFFD/u, "");
}

function parseOperation(value: unknown): PortalFleetUpdateOperation {
  return operationSchema.parse(value);
}

function operationLock(configDir: string): UpdateLock {
  return acquireUpdateLock(join(configDir, "portal-updates", "operation"), {
    owner: "portal fleet update operation",
    currentStep: "persisting durable operation state",
  });
}

/** Claim sole ownership of the portal updater wrapper across processes. */
export function acquirePortalFleetUpdateRunnerClaim(configDir: string): UpdateLock {
  return acquireUpdateLock(join(configDir, "portal-updates", "runner"), {
    owner: "portal fleet update runner",
    currentStep: "updating the gateway host and fleet",
  });
}

/** Return null only when no operation has ever been recorded. Invalid state fails closed. */
export function readPortalFleetUpdateOperation(
  configDir: string,
): PortalFleetUpdateOperation | null {
  let raw: string;
  try {
    raw = readFileSync(portalFleetUpdateOperationPath(configDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseOperation(JSON.parse(raw) as unknown);
}

/** Validate and atomically persist an owner-only operation record. */
function writePortalFleetUpdateOperationUnlocked(
  configDir: string,
  operation: PortalFleetUpdateOperation,
): PortalFleetUpdateOperation {
  const validated = parseOperation(operation);
  atomicWriteFileSync(
    portalFleetUpdateOperationPath(configDir),
    `${JSON.stringify(validated, null, 2)}\n`,
    { mode: 0o600, ensureDir: true },
  );
  return validated;
}

/** Validate and atomically persist while excluding every cross-process transition. */
export function writePortalFleetUpdateOperation(
  configDir: string,
  operation: PortalFleetUpdateOperation,
): PortalFleetUpdateOperation {
  const lock = operationLock(configDir);
  try {
    return writePortalFleetUpdateOperationUnlocked(configDir, operation);
  } finally {
    lock.release();
  }
}

/**
 * Persist a new operation only when no active owner already exists. The read
 * and write share one cross-process lock so concurrent portal requests cannot
 * launch two host updaters from the same initially empty record.
 */
export function createPortalFleetUpdateOperation(
  configDir: string,
  operation: PortalFleetUpdateOperation,
): { operation: PortalFleetUpdateOperation; created: boolean } {
  const lock = operationLock(configDir);
  try {
    const current = readPortalFleetUpdateOperation(configDir);
    if (current?.state === "queued" || current?.state === "running") {
      return { operation: current, created: false };
    }
    return {
      operation: writePortalFleetUpdateOperationUnlocked(configDir, operation),
      created: true,
    };
  } finally {
    lock.release();
  }
}

/** Read, transform, validate, and atomically replace the current record. */
export function updatePortalFleetUpdateOperation(
  configDir: string,
  updater: (current: PortalFleetUpdateOperation) => PortalFleetUpdateOperation,
): PortalFleetUpdateOperation {
  const lock = operationLock(configDir);
  try {
    const current = readPortalFleetUpdateOperation(configDir);
    if (!current) throw new Error("Portal fleet update operation does not exist");
    const next = updater(current);
    for (const key of [
      "id",
      "currentVersion",
      "targetVersion",
      "releaseCheckedAt",
      "startedAt",
    ] as const) {
      if (next[key] !== current[key]) {
        throw new Error(`Portal fleet update operation ${key} is immutable`);
      }
    }
    return writePortalFleetUpdateOperationUnlocked(configDir, next);
  } finally {
    lock.release();
  }
}
