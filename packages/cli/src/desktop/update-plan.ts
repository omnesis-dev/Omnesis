// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { valid } from "semver";
import { assessUpdate } from "../update/detect.js";
import type { DesktopUpdateRelease } from "./update-release.js";

const generation = z.number().int().nonnegative().max(1_000_000);
export const desktopUpdateMetadataSchema = z
  .object({
    format: z.literal(1),
    bundleIdentifier: z.literal("dev.omnesis.desktop"),
    productVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .refine((value) => valid(value) !== null),
    architecture: z.enum(["arm64", "x64"]),
    compat: z.object({
      productVersion: z.string(),
      stores: z.object({
        mainDb: z.object({ policy: z.literal("numbered-migrations"), version: generation }),
        config: z.object({ policy: z.literal("in-place"), version: generation }),
      }),
      protocols: z.object({ ws: generation }),
    }),
  })
  .refine(
    (value) => value.productVersion === value.compat.productVersion,
    "Product versions must agree",
  );
export type DesktopUpdateMetadata = z.infer<typeof desktopUpdateMetadataSchema>;
export interface DesktopUpdatePlan {
  source: "official-release" | "current-application";
  currentVersion: string;
  targetVersion: string;
  architecture: "arm64" | "x64";
  migration: boolean;
  backupRequired: true;
  requiredFreeBytes: number;
  recovery: "resume-before-start-or-restore-backup-after-start";
}

/** Call only with metadata read by the native adapter AFTER source signature and notary assessment. */
interface DesktopUpdateInputs {
  current: unknown;
  candidate: unknown;
  mode: "home" | "joined";
  observed: { mainDbVersion: number; configVersion: number; remoteWsVersion?: number };
  payloadBytes: number;
  applicationBytes: number;
  oldApplicationBytes: number;
  backupBytes: number;
  freeBytes: number;
}

export function planDesktopUpdate(
  options: DesktopUpdateInputs & { release: DesktopUpdateRelease },
): DesktopUpdatePlan {
  return buildDesktopUpdatePlan(options, options.release, "official-release");
}

/** Native must bind these metadata/epochs to the currently executing application, never a pipe path. */
export function planDesktopCurrentApplicationReplacement(
  options: DesktopUpdateInputs & { oldEpoch: string; candidateEpoch: string },
): DesktopUpdatePlan {
  const digest = z.string().regex(/^[a-f0-9]{64}$/);
  digest.parse(options.oldEpoch);
  digest.parse(options.candidateEpoch);
  if (options.oldEpoch === options.candidateEpoch)
    throw new Error("This application's runtime is already active");
  const candidate = desktopUpdateMetadataSchema.parse(options.candidate);
  return buildDesktopUpdatePlan(
    options,
    {
      version: candidate.productVersion,
      architecture: candidate.architecture,
      bytes: 0,
    },
    "current-application",
  );
}

function buildDesktopUpdatePlan(
  options: DesktopUpdateInputs,
  artifact: Pick<DesktopUpdateRelease, "version" | "architecture" | "bytes">,
  source: DesktopUpdatePlan["source"],
): DesktopUpdatePlan {
  const current = desktopUpdateMetadataSchema.parse(options.current);
  const candidate = desktopUpdateMetadataSchema.parse(options.candidate);
  const assessment = assessUpdate(current.productVersion, candidate.productVersion);
  if (
    assessment.requiresForce ||
    assessment.direction === "downgrade" ||
    (source === "official-release" && assessment.direction !== "upgrade")
  )
    throw new Error("Desktop updates require a strictly newer stable release");
  if (
    candidate.productVersion !== artifact.version ||
    candidate.architecture !== artifact.architecture ||
    current.architecture !== candidate.architecture
  )
    throw new Error("The verified installer does not match the selected release or this Mac");
  const observed = z
    .object({
      mainDbVersion: generation,
      configVersion: generation,
      remoteWsVersion: generation.optional(),
    })
    .parse(options.observed);
  if (
    candidate.compat.stores.mainDb.version < observed.mainDbVersion ||
    candidate.compat.stores.config.version < observed.configVersion
  )
    throw new Error("The verified installer cannot read this installation's newer data");
  if (
    options.mode === "joined" &&
    (observed.remoteWsVersion === undefined ||
      observed.remoteWsVersion !== candidate.compat.protocols.ws)
  )
    throw new Error("Update the home library before installing this version on a connected Mac");
  const quantities = [
    artifact.bytes,
    options.payloadBytes,
    options.applicationBytes,
    options.oldApplicationBytes,
    options.backupBytes,
    options.freeBytes,
  ];
  if (
    quantities.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    (source === "official-release" && artifact.bytes === 0) ||
    options.payloadBytes === 0 ||
    options.applicationBytes < options.payloadBytes ||
    options.oldApplicationBytes === 0
  )
    throw new Error("The desktop update disk measurements are invalid");
  // Download, immutable staging and the retained recovery snapshot coexist. Existing payloads stay live.
  const requiredFreeBytes =
    artifact.bytes +
    options.payloadBytes +
    options.applicationBytes +
    options.oldApplicationBytes +
    options.backupBytes +
    512 * 1024 ** 2;
  if (!Number.isSafeInteger(requiredFreeBytes) || options.freeBytes < requiredFreeBytes)
    throw new Error(
      "Free disk space for the installer, staged runtime and recovery backup before updating",
    );
  return {
    source,
    currentVersion: current.productVersion,
    targetVersion: candidate.productVersion,
    architecture: candidate.architecture,
    migration:
      candidate.compat.stores.mainDb.version > observed.mainDbVersion ||
      candidate.compat.stores.config.version > observed.configVersion,
    backupRequired: true,
    requiredFreeBytes,
    recovery: "resume-before-start-or-restore-backup-after-start",
  };
}
