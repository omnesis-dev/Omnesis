// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { readDesktopInstall } from "./bootstrap.js";
import {
  assertDesktopProfileGeneration,
  desktopProfileForGeneration,
  readDesktopGeneration,
} from "./generation.js";
import { assertDesktopProcessAuthority } from "./process-authority.js";
import { readDesktopPrivateRecord } from "./private-record.js";
import { desktopRestoreBlocked } from "./restore-intent.js";
import { desktopRootIdentity, readDesktopRetirement, sameDesktopRoot } from "./retirement.js";
import { readDesktopActiveRuntime } from "./update-active.js";
import { readDesktopUpdateState } from "./update-state.js";
import { verifyDesktopUpdateSnapshot } from "./update-snapshot.js";
import type { DesktopProfile } from "./environment.js";
import type { ManagedDesktopBackgroundBinding } from "@omnesis/core";

export interface DesktopBackgroundHandoff {
  kind: "candidate" | "previous" | "fresh-install" | "origin-recovery";
  mode: "home" | "joined";
}
const erasedSchema = z
  .object({
    version: z.literal(1),
    owner: z.literal("omnesis-desktop"),
    instance: z.string(),
    secretService: z.string(),
    operationId: z.string().uuid(),
    mode: z.literal("erase-data"),
    phase: z.literal("complete"),
    root: z
      .object({ device: z.string().regex(/^\d+$/u), inode: z.string().regex(/^\d+$/u) })
      .strict(),
  })
  .strict();
const refused = () =>
  new Error("Review the pending application handoff before changing the background app");
/** Read-only policy. Caller owns install/session leases; only the daemon may claim an update epoch. */
export async function validateDesktopBackgroundHandoff(
  profile: DesktopProfile,
  epoch: string,
  binding: ManagedDesktopBackgroundBinding,
  signal: AbortSignal,
  dependencies: { verifySnapshot?: typeof verifyDesktopUpdateSnapshot } = {},
): Promise<DesktopBackgroundHandoff | null> {
  signal.throwIfAborted();
  assertDesktopProfileGeneration(profile);
  await assertDesktopProcessAuthority(profile);
  if (binding.scope.configDir !== profile.configDir) throw refused();
  const sameScope =
    binding.scope.instance === profile.instance &&
    binding.scope.secretService === profile.secretService;
  const state = await readDesktopUpdateState(profile);
  // Matching ordinary owners need no handoff. Existing restore/start policy stays authoritative.
  if (
    sameScope &&
    binding.epoch === epoch &&
    binding.origin.state === "verified" &&
    !(
      state &&
      epoch === state.candidateEpoch &&
      ["backed-up", "installer-opened", "candidate-started"].includes(state.phase)
    )
  )
    return null;
  if ((await readDesktopRetirement(profile)) || (await desktopRestoreBlocked(profile)))
    throw refused();
  const install = await readDesktopInstall(profile);
  if (!install || install.phase !== "configured") throw refused();
  if (state && sameScope) {
    const candidate =
      epoch === state.candidateEpoch &&
      ["backed-up", "installer-opened", "candidate-started", "complete"].includes(state.phase);
    const previous = epoch === state.oldEpoch && state.phase === "resumed";
    if ((candidate || previous) && [state.oldEpoch, state.candidateEpoch].includes(binding.epoch)) {
      if (!sameDesktopRoot(await desktopRootIdentity(profile), state.root)) throw refused();
      const active = await readDesktopActiveRuntime(profile);
      if (!active || ![state.oldEpoch, state.candidateEpoch].includes(active.epoch))
        throw refused();
      if (candidate && !state.backup) throw refused();
      if (state.backup)
        await (dependencies.verifySnapshot ?? verifyDesktopUpdateSnapshot)(profile, {
          operationId: state.operationId,
          manifestSha256: state.backup.manifestSha256,
          signal,
        });
      signal.throwIfAborted();
      return { kind: candidate ? "candidate" : "previous", mode: install.mode };
    }
  }
  if (!sameScope) {
    const generation = readDesktopGeneration(profile.configDir);
    const current = generation
      ? desktopProfileForGeneration(profile.configDir, generation.generation)
      : null;
    if (
      !generation ||
      current?.instance !== profile.instance ||
      current.secretService !== profile.secretService ||
      generation.previous.instance !== binding.scope.instance ||
      generation.previous.secretService !== binding.scope.secretService
    )
      throw refused();
    const erased = await readDesktopPrivateRecord(profile, "retirement.json", (value) =>
      erasedSchema.parse(value),
    );
    const root = await desktopRootIdentity(profile);
    if (
      !erased ||
      !root ||
      erased.instance !== generation.previous.instance ||
      erased.secretService !== generation.previous.secretService ||
      erased.operationId !== generation.previous.retirementId ||
      state !== null ||
      (await readDesktopActiveRuntime(profile))
    )
      throw refused();
    signal.throwIfAborted();
    return { kind: "fresh-install", mode: install.mode };
  }
  if (binding.epoch !== epoch) throw refused();
  if (sameScope && binding.origin.state !== "verified" && state === null) {
    const root = await desktopRootIdentity(profile);
    const active = await readDesktopActiveRuntime(profile);
    if (!root || (active && active.epoch !== epoch)) throw refused();
    signal.throwIfAborted();
    return { kind: "origin-recovery", mode: install.mode };
  }
  throw refused();
}
