// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { basename, isAbsolute, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";
import { z } from "zod";
import { managedRuntimeLauncherContext, type NodeCommandInvocation } from "./node-command.js";
import { assertManagedDesktopBackgroundOwner } from "./managed-background.js";

type Profile = { configDir: string; instance: string; secretService: string };
const failed = () => new Error("The nearby library query requires its verified desktop controller");
/** Structural validation only. The routing package still applies its authoritative private-IP schema. */
export class ManagedDesktopNearbyCleanupError extends Error {
  constructor(cause: unknown) {
    super("Nearby discovery cleanup is unconfirmed", { cause });
  }
}
export const managedDesktopNearbySnapshotSchema = z
  .object({
    format: z.literal(1),
    generation: z.string().uuid(),
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    state: z.enum(["finding", "ready", "denied", "unavailable"]),
    candidates: z
      .array(
        z
          .object({
            address: z.string().min(1).max(45),
            port: z.number().int().min(1).max(65535),
            remainingMs: z.number().int().min(1).max(30_000),
          })
          .strict(),
      )
      .max(8),
  })
  .strict()
  .refine(
    (value) => !["denied", "unavailable"].includes(value.state) || value.candidates.length === 0,
  );
export type ManagedDesktopNearbySnapshot = z.infer<typeof managedDesktopNearbySnapshotSchema>;

/** Read-only fixed native mode; never relaxes the separate binding/rebind factories. */
export function managedDesktopNearbyInvocation(
  profile: Profile,
  sourceMetaUrl: string,
): NodeCommandInvocation | null {
  const context = managedRuntimeLauncherContext();
  if (!context) {
    if (process.platform === "darwin" && !new URL(sourceMetaUrl).pathname.endsWith(".ts"))
      throw failed();
    return null;
  }
  const epoch = basename(context.root);
  if (
    !isMainThread ||
    context.data ||
    context.backgroundRetirement !== undefined ||
    !isAbsolute(profile.configDir) ||
    resolve(profile.configDir) !== profile.configDir ||
    !/^desktop-[a-f0-9]{16}$/u.test(profile.instance) ||
    !/^dev\.omnesis\.desktop\.[a-f0-9]{64}$/u.test(profile.secretService) ||
    !/^[a-f0-9]{64}$/u.test(epoch)
  )
    throw failed();
  // Daemon entry already verifies its signed parent. Keep the retained exact owner/channel assertion.
  if (context.backgroundOwner !== undefined) assertManagedDesktopBackgroundOwner(profile);
  const value = Buffer.from(
    JSON.stringify({ version: 1, scope: { format: 1, ...profile }, epoch }),
  );
  if (value.length > 4096) throw failed();
  return { command: context.launcher, args: ["--background-nearby", value.toString("base64url")] };
}
