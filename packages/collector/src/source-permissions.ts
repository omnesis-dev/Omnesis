// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  parseSourceKey,
  sourcePermissionRequirementSchema,
  sourcePermissionScopeDigest,
  sourcePermissionsRequestSchema,
  sourcePermissionsResponseSchema,
  type SourcePermissionsRequest,
  type SourcePermissionsResponse,
} from "@omnesis/core";
import { DoctorReadAccess } from "./doctor-read-access.js";
import type { SourceDescriptor, SourceInstance } from "@omnesis/source-sdk";
import type { RegisteredSource } from "./sync-engine-types.js";

type Probe = Pick<SourceInstance, "probeReadAccess" | "probeLocalStores" | "probePermissionAccess">;

/** Metadata checks share the doctor's deadlines and ownership of late-opened handles. */
export class CollectorSourcePermissions {
  private readonly probes: DoctorReadAccess;
  private readonly candidates = new Map<string, Probe>();
  constructor(
    private readonly configDir: string,
    changed?: () => void,
  ) {
    this.probes = new DoctorReadAccess(undefined, changed, "permissions");
  }
  async close(): Promise<void> {
    await this.probes.close();
    this.candidates.clear();
  }
  cleanupFailure(): unknown {
    return this.probes.cleanupFailure();
  }

  async check(
    raw: SourcePermissionsRequest,
    descriptor: SourceDescriptor,
    source?: RegisteredSource,
    publicationGuard?: SourcePermissionsResponse["publicationGuard"],
  ): Promise<SourcePermissionsResponse> {
    const request = sourcePermissionsRequestSchema.parse(raw);
    if (request.descriptorId !== descriptor.id)
      throw new Error("Permission request does not match descriptor");
    if (
      request.sourceId &&
      (parseSourceKey(request.sourceId).sourceType !== descriptor.id ||
        (source && source.id !== request.sourceId))
    )
      throw new Error("Permission source does not match descriptor");
    if (request.sourceId && request.params !== undefined)
      throw new Error("Configured access cannot override source parameters");
    const requirements =
      descriptor.permissionRequirements === undefined
        ? undefined
        : sourcePermissionRequirementSchema
            .array()
            .max(16)
            .parse(descriptor.permissionRequirements);
    const scopeDigest = request.sourceId
      ? (source?.permissionScopeDigest ??
        request.expectedScopeDigest ??
        sourcePermissionScopeDigest(descriptor.id, request.accountId, {}))
      : sourcePermissionScopeDigest(descriptor.id, request.accountId, request.params);
    // The runner enforces blocking declarations on the registered instance, not fleet metadata.
    const guarded =
      publicationGuard &&
      requirements?.some((requirement) => requirement.blocking) &&
      (!request.sourceId ||
        source?.permissionRequirements?.some((requirement) => requirement.blocking));
    const response = (status: SourcePermissionsResponse["status"]) =>
      sourcePermissionsResponseSchema.parse({
        descriptorId: request.descriptorId,
        ...(request.sourceId ? { sourceId: request.sourceId } : {}),
        checkedAt: new Date().toISOString(),
        scopeDigest,
        status,
        ...(requirements ? { requirements } : {}),
        target: "unverified",
        ...(guarded ? { publicationGuard } : {}),
      });
    if (requirements === undefined) return response("unsupported");
    if (requirements.length === 0) return response("not-required");
    let instance: Probe | undefined;
    if (request.sourceId) {
      if (
        !source?.permissionScopeDigest ||
        (request.expectedScopeDigest &&
          source.permissionScopeDigest !== request.expectedScopeDigest)
      )
        return response("unavailable");
      instance = source.instance;
    } else if (descriptor.probePermissionAccess) {
      instance = this.candidates.get(scopeDigest);
      if (!instance) {
        // Only physically completed identities may be evicted, never timed-out raw work.
        if (this.candidates.size >= 64) {
          const oldest = [...this.candidates].find(
            ([, candidate]) => !this.probes.hasPending(candidate),
          );
          if (!oldest) return response("unavailable");
          this.candidates.delete(oldest[0]);
        }
        const probe = descriptor.probePermissionAccess;
        const params = { ...request.params };
        instance = {
          probeReadAccess: ({ signal }) =>
            probe({ configDir: this.configDir, accountId: request.accountId, params, signal }),
        };
      }
      this.candidates.delete(scopeDigest);
      this.candidates.set(scopeDigest, instance);
    }
    if (!instance) return response("unsupported");
    try {
      const [observation] = await this.probes.collect(
        [{ sourceId: request.sourceId ?? descriptor.id, instance }],
        new AbortController().signal,
      );
      return response(observation?.status ?? "unavailable");
    } catch (error) {
      // Keep the cause's cleanup receipt for shutdown, never its diagnostic on the wire.
      throw new Error("The collection access check could not finish", { cause: error });
    }
  }
}
