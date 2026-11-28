// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { basename, dirname, join } from "node:path";
import { assertNever } from "@omnesis/core";
import { z } from "zod";
import { gt, valid } from "semver";
import { readDesktopPrivateRecord, writeDesktopPrivateRecord } from "./private-record.js";
import type { DesktopProfile } from "./environment.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/)
  .refine((value) => valid(value) !== null);
export const desktopUpdateStateSchema = z
  .object({
    format: z.literal(1),
    owner: z.literal("omnesis-desktop"),
    instance: z.string().min(1),
    secretService: z.string().min(1),
    operationId: z.string().uuid(),
    phase: z.enum([
      "verified",
      "stopping",
      "backed-up",
      "installer-opened",
      "candidate-started",
      "complete",
      "recovery-required",
      "resumed",
    ]),
    mode: z.enum(["home", "joined"]),
    source: z.enum(["official-release", "current-application"]).optional(),
    oldEpoch: digest,
    candidateEpoch: digest,
    oldVersion: version,
    candidateVersion: version,
    artifactSha256: digest,
    root: z
      .object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) })
      .strict(),
    backup: z
      .object({ manifestSha256: digest, bytes: z.number().int().nonnegative().safe() })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (value) =>
      valid(value.candidateVersion) !== null &&
      valid(value.oldVersion) !== null &&
      (gt(value.candidateVersion, value.oldVersion) ||
        (value.source === "current-application" && value.candidateVersion === value.oldVersion)),
    "Release updates must increase; explicit current-application replacements cannot downgrade",
  )
  .refine((value) => value.oldEpoch !== value.candidateEpoch, "Runtime epochs must differ")
  .refine(
    (value) =>
      !["backed-up", "installer-opened", "candidate-started", "complete"].includes(value.phase) ||
      value.backup !== null,
    "An update cannot open the replacement without its recovery snapshot",
  );
export type DesktopUpdateState = z.infer<typeof desktopUpdateStateSchema>;

export function desktopUpdateStatePath(profile: DesktopProfile): string {
  return join(`${profile.configDir}.bootstrap`, "update.json");
}
export function desktopRuntimeEpoch(executable: string = process.execPath): string | null {
  const epoch = basename(dirname(executable));
  return /^[a-f0-9]{64}$/.test(epoch) ? epoch : null;
}

/** The old runtime never resumes against possibly migrated state without an explicit recovery. */
export function desktopUpdateEpochDisposition(
  state: DesktopUpdateState | null,
  epoch: string | null,
): "allow" | "block" | "claim" {
  if (!state) return "allow";
  switch (state.phase) {
    case "verified":
    case "resumed":
      return epoch === state.oldEpoch ? "allow" : "block";
    case "stopping":
    case "recovery-required":
      return "block";
    case "backed-up":
    case "installer-opened":
      return epoch === state.candidateEpoch ? "claim" : "block";
    case "candidate-started":
    case "complete":
      return epoch === state.candidateEpoch ? "allow" : "block";
    default:
      return assertNever(state.phase);
  }
}

export async function readDesktopUpdateState(
  profile: DesktopProfile,
): Promise<DesktopUpdateState | null> {
  const state = await readDesktopPrivateRecord(profile, "update.json", (value) =>
    desktopUpdateStateSchema.parse(value),
  );
  if (state) identity(profile, state);
  return state;
}
/** Caller holds the external installation lease throughout each transition. */
export async function writeDesktopUpdateState(
  profile: DesktopProfile,
  value: DesktopUpdateState,
): Promise<void> {
  const state = desktopUpdateStateSchema.parse(value);
  identity(profile, state);
  await writeDesktopPrivateRecord(profile, "update.json", state);
}
function identity(profile: DesktopProfile, state: DesktopUpdateState): void {
  if (state.instance !== profile.instance || state.secretService !== profile.secretService)
    throw new Error("The desktop update record belongs to another installation");
}
