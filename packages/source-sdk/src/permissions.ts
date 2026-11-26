// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { PermissionAction } from "@omnesis/types";
import type { SourceReadAccessResult } from "./define-source.js";

/** Provider-owned purpose and scope, with no local paths or indexed content. */
export interface SourcePermissionRequirement {
  id: string;
  kind: "protected-files" | "selected-folder";
  summary: string;
  scope: string;
  blocking: boolean;
  actions: PermissionAction[];
}

/** Candidate probes must only open/inspect metadata, never create a provider or read records. */
export interface SourcePermissionProbeOptions {
  configDir: string;
  accountId?: string;
  params: Record<string, string>;
  signal: AbortSignal;
}
export interface SourcePermissionDeclaration {
  /** Absent is unknown; explicitly empty means no local permission is required. */
  permissionRequirements?: SourcePermissionRequirement[];
  probePermissionAccess?(options: SourcePermissionProbeOptions): Promise<SourceReadAccessResult>;
}
