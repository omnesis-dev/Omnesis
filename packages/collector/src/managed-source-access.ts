// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SyncError, type SyncRemediation } from "@omnesis/types";
import type { RegisteredSource } from "./sync-engine-types.js";
import type { DoctorReadAccess } from "./doctor-read-access.js";

export function managedAccessRemediation(source: RegisteredSource): SyncRemediation {
  return {
    summary: "Review this source's collection access",
    ...(source.permissionScopeDigest
      ? {
          access: {
            status: "denied" as const,
            checkedAt: new Date().toISOString(),
            scopeDigest: source.permissionScopeDigest,
            target: "unverified" as const,
          },
        }
      : {}),
    steps: [
      "Open collection access guidance on the computer hosting this source, then check again. Indexed information is kept.",
    ],
    restartRequired: false,
    actions: [
      ...new Map(
        (source.permissionRequirements ?? [])
          .flatMap((requirement) => requirement.actions)
          .map((action) => [JSON.stringify(action), action]),
      ).values(),
    ].slice(0, 8),
  };
}

/** Managed collection checks capability before reading and again before publishing a page. */
export async function assertManagedSourceAccess(
  source: RegisteredSource,
  probes: DoctorReadAccess | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (!probes || !source.permissionRequirements?.some((requirement) => requirement.blocking))
    return;
  const [observation] = await probes.collect(
    [{ sourceId: source.id, instance: source.instance }],
    signal,
  );
  signal.throwIfAborted();
  // A bounded health scan is not a full enumeration. Unknown is never a grant,
  // but cannot permanently disable a reader whose own coverage contract withholds gaps.
  if (observation?.status !== "denied") return;
  throw new SyncError("permission", "Collection access is blocked on this computer", {
    remediation: managedAccessRemediation(source),
  });
}
