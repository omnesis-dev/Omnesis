// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  compareStableReleaseVersions,
  detectDockerInstall,
  detectInstallMethod,
  type InstallMethod,
  type ReleaseCheckSnapshot,
} from "@omnesis/core/release-check";
import { lookupLatestRelease, type ReleaseLookupDeps } from "./lookup.js";

export const DEFAULT_RELEASE_CHECK_ENABLED = true;

export interface ReleaseCheckServiceOptions {
  configDir: string;
  argv1Path: string;
  currentVersion: string;
  enabled?: boolean;
  installMethod?: InstallMethod;
  lookup?: typeof lookupLatestRelease;
  lookupDeps?: ReleaseLookupDeps;
  now?: () => number;
}

/**
 * In-memory authority for the last successful release lookup. Failures do not
 * clear or mutate an earlier answer; disabling the feature intentionally does.
 */
export class ReleaseCheckService {
  private enabled: boolean;
  private readonly installMethod: InstallMethod;
  private readonly lookup: typeof lookupLatestRelease;
  private readonly lookupDeps: ReleaseLookupDeps;
  private readonly now: () => number;
  private value: Readonly<ReleaseCheckSnapshot> | null = null;
  private generation = 0;

  constructor(private readonly options: ReleaseCheckServiceOptions) {
    this.enabled = options.enabled ?? DEFAULT_RELEASE_CHECK_ENABLED;
    this.installMethod =
      options.installMethod ??
      detectDockerInstall(options.configDir) ??
      detectInstallMethod(options.argv1Path);
    this.lookup = options.lookup ?? lookupLatestRelease;
    this.lookupDeps = options.lookupDeps ?? {};
    this.now = options.now ?? Date.now;
  }

  snapshot(): ReleaseCheckSnapshot | null {
    return this.value ? { ...this.value } : null;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.generation += 1;
    if (!enabled) this.value = null;
  }

  /** Run one best-effort lookup. This method never rejects. */
  async check(signal: AbortSignal): Promise<boolean> {
    if (!this.enabled || this.installMethod.method === "unknown") return false;
    const generation = ++this.generation;
    try {
      const latestVersion = await this.lookup(this.installMethod, this.lookupDeps, signal);
      const compared = latestVersion
        ? compareStableReleaseVersions(this.options.currentVersion, latestVersion)
        : null;
      if (!latestVersion || compared === null || !this.enabled || generation !== this.generation) {
        return false;
      }
      this.value = Object.freeze({
        currentVersion: this.options.currentVersion,
        latestVersion,
        installMethod: this.installMethod.method,
        checkedAt: new Date(this.now()).toISOString(),
        updateAvailable: compared < 0,
      });
      return true;
    } catch {
      return false;
    }
  }
}
