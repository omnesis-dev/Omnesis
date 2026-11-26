// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { SCOPE_ADMIN } from "@omnesis/core";
import { registerVerifiedDesktopRestoreSnapshot } from "./snapshot-retention.js";
import { assertDesktopProcessAuthority } from "./process-authority.js";
import { desktopRestoreDeletionPaused, desktopRestoreRecordingsPaused } from "./restore-review.js";
import { desktopRestoreModelsPaused } from "./restore-models.js";
import { readDesktopRestoreFile } from "./restore-files.js";
import { withDesktopRestoreOperationLease } from "./restore-owner.js";
import { resumeRetiredDesktop } from "./removal.js";
import { withDesktopInstallLease } from "./bootstrap.js";
import { acquireDesktopRuntimeLeases } from "./runtime-leases.js";
import { DesktopRestoreProtection } from "./restore-protection.js";
import { readDesktopRestoreIntent, writeDesktopRestoreIntent } from "./restore-intent.js";
import { readDesktopRetirement, sameDesktopRoot } from "./retirement.js";
import { desktopRuntimeEpoch } from "./update-state.js";
import type { DesktopRestoreActivation } from "./restore-activation.js";
import type { DesktopProfile } from "./environment.js";
import type { CoordinatorDependencies } from "./coordinator-runtime.js";

type Operations = Pick<
  CoordinatorDependencies,
  "stopDaemon" | "startDaemon" | "request" | "connection" | "sleep"
>;
const healthSchema = z.object({
  status: z.literal("ok"),
  storageProtection: z.object({ version: z.literal(1), atRest: z.literal("encrypted") }),
  compat: z.object({ schema: z.number().int().positive() }),
});
/** Explicit native Start only. Ordinary status/daemon boot can never create this authorization. */
export async function startCommittedDesktopRestore(
  profile: DesktopProfile,
  signal: AbortSignal,
  operations: Operations,
): Promise<boolean> {
  const record = await readDesktopRestoreIntent(profile);
  if (!record || !["committed", "starting"].includes(record.phase)) return false;
  await assertDesktopProcessAuthority(profile);
  return withDesktopRestoreOperationLease(profile, signal, async () => {
    const retirement = await readDesktopRetirement(profile);
    if (retirement?.mode === "keep-data" && retirement.phase === "complete")
      await resumeRetiredDesktop(profile, signal);
    const attempt = await withDesktopInstallLease(profile, signal, async () => {
      const current = await readDesktopRestoreIntent(profile);
      if (
        !current ||
        current.operationId !== record.operationId ||
        !["committed", "starting"].includes(current.phase) ||
        !current.verification
      )
        throw new Error("Recover or preview this backup before starting it");
      if (await readDesktopRetirement(profile)) throw new Error("This installation has retired");
      const protection = await DesktopRestoreProtection.capture(profile, signal);
      try {
        const identity = protection.identity();
        if (
          !sameDesktopRoot(identity.root, current.root) ||
          identity.keyDigest !== current.targetKeyDigest
        )
          throw new Error("Recover this library's original protection before starting it");
        const stopped = await operations.stopDaemon(profile, signal);
        const leases = await acquireDesktopRuntimeLeases(profile, {
          signal,
          expectedRoot: current.root,
          runtimeWaitMs: stopped ? 5000 : 0,
        });
        try {
          signal.throwIfAborted();
          const authorization: DesktopRestoreActivation = {
            operationId: current.operationId,
            attemptId: randomUUID(),
            epoch: desktopRuntimeEpoch(),
          };
          await writeDesktopRestoreIntent(profile, {
            ...current,
            phase: "starting",
            activation: {
              attemptId: authorization.attemptId,
              epoch: authorization.epoch,
              claimed: false,
            },
          });
          return { authorization, verification: current.verification };
        } finally {
          leases.release();
        }
      } finally {
        protection.close();
      }
    });
    const activeSignal = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
    try {
      await operations.startDaemon(profile, attempt.authorization, activeSignal);
      for (;;) {
        activeSignal.throwIfAborted();
        try {
          const health = healthSchema.parse(
            await operations.request(profile, "/health", { signal: activeSignal }),
          );
          if (health.compat.schema !== attempt.verification.schemaVersion)
            throw new Error("Unexpected restored schema");
          break;
        } catch {
          activeSignal.throwIfAborted();
          await operations.sleep(activeSignal);
        }
      }
      const identity = z
        .object({ tokenId: z.string().uuid(), scopes: z.array(z.string()) })
        .parse(await operations.request(profile, "/whoami", { signal: activeSignal }));
      if (!identity.scopes.includes(SCOPE_ADMIN))
        throw new Error("The restored gateway did not retain this Mac's administrative identity");
      const connection = await operations.connection(profile);
      if (
        createHash("sha256").update(connection.token.trim()).digest("hex") !==
        attempt.verification.tokenDigest
      )
        throw new Error("The restored gateway identity changed");
      for (;;) {
        activeSignal.throwIfAborted();
        try {
          const status = z
            .object({
              documents: z.object({ total: z.number().int().nonnegative().safe() }),
              lab: z.object({
                brain: z.literal(false),
                tasks: z.literal(false),
                watches: z.literal(false),
              }),
            })
            .parse(await operations.request(profile, "/status", { signal: activeSignal }));
          const sources = z
            .object({
              items: z.array(z.object({ enabled: z.literal(false) })),
              pageInfo: z.object({ hasMore: z.literal(false) }),
            })
            .parse(await operations.request(profile, "/admin/sources", { signal: activeSignal }));
          if (
            status.documents.total < attempt.verification.documents ||
            sources.items.length !== attempt.verification.sources
          )
            throw new Error("The restored data is not ready");
          break;
        } catch {
          activeSignal.throwIfAborted();
          await operations.sleep(activeSignal);
        }
      }
      const config = z
        .object({ config: z.unknown() })
        .parse(await operations.request(profile, "/admin/config", { signal: activeSignal }));
      if (
        !desktopRestoreModelsPaused(config.config) ||
        !desktopRestoreDeletionPaused(config.config) ||
        !desktopRestoreRecordingsPaused(config.config, attempt.verification.recordings ?? 0)
      )
        throw new Error("Review model assignments before processing restored data");
      if (
        attempt.verification.configDigest &&
        createHash("sha256")
          .update(
            await readDesktopRestoreFile(join(profile.configDir, "omnesis.json"), 1024 * 1024),
          )
          .digest("hex") !== attempt.verification.configDigest
      )
        throw new Error("The reviewed restore configuration changed before verification");
      await withDesktopInstallLease(profile, activeSignal, async () => {
        const current = await readDesktopRestoreIntent(profile);
        if (await readDesktopRetirement(profile))
          throw new Error("This installation retired during restore verification");
        if (
          !current ||
          current.phase !== "starting" ||
          current.operationId !== attempt.authorization.operationId ||
          !current.activation?.claimed ||
          current.activation.attemptId !== attempt.authorization.attemptId
        )
          throw new Error("The startup verification no longer belongs to this restore");
        const protection = await DesktopRestoreProtection.capture(profile, activeSignal);
        try {
          if (
            !sameDesktopRoot(current.root, protection.identity().root) ||
            current.targetKeyDigest !== protection.identity().keyDigest
          )
            throw new Error("The library protection changed during verification");
          const complete = {
            ...current,
            phase: "complete" as const,
            verification: { ...attempt.verification, verifiedAt: new Date().toISOString() },
          };
          await registerVerifiedDesktopRestoreSnapshot(profile, complete, activeSignal);
          await writeDesktopRestoreIntent(profile, complete);
        } finally {
          protection.close();
        }
      });
      return true;
    } catch (error) {
      // Failed verification never clears the startup fence or releases a collector.
      // Stop only our daemon; an unconfirmed stop remains fenced for explicit recovery.
      await withDesktopInstallLease(profile, new AbortController().signal, async () => {
        const current = await readDesktopRestoreIntent(profile);
        if (
          !(await readDesktopRetirement(profile)) &&
          current?.phase === "starting" &&
          current.operationId === attempt.authorization.operationId &&
          current.activation?.attemptId === attempt.authorization.attemptId
        )
          await operations.stopDaemon(profile, new AbortController().signal).catch(() => false);
      });
      if (signal.aborted) signal.throwIfAborted();
      throw new Error(
        "The backup was applied, but protected startup has not been verified. Retry Start or recover your previous library.",
        { cause: error },
      );
    }
  });
}
