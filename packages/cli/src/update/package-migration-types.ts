// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Supervisor } from "../service/supervisor.js";
import type { CommandSpec, HostRoles } from "./detect.js";
import type { UpdateInterruptionRouter } from "./interruption.js";

export interface MigrationRunOutcome {
  code: number;
  stdout: string;
}

export interface MigrationRunControl {
  signal?: AbortSignal;
  onProcessGroup?(pid: number | null): void;
}

export type MigrationRunner = (
  spec: CommandSpec,
  mode: "capture" | "inherit",
  control?: MigrationRunControl,
) => Promise<MigrationRunOutcome>;

export interface SourceToPackageOptions {
  registry?: string;
  dryRun: boolean;
  keepCheckout: boolean;
  healthTimeoutMs: number;
}

export interface SourceToPackageDeps {
  run: MigrationRunner;
  supervisor: Supervisor;
  roles: HostRoles;
  platform: NodeJS.Platform;
  homeDir: string;
  configDir: string;
  argv1: string;
  cwd: string;
  currentVersion: string;
  confirm(message: string): Promise<void>;
  approve(message: string): Promise<boolean>;
  awaitHealth(
    expectVersion: string,
    bind: string,
    port: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void>;
  canWrite(path: string): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  interruptions: UpdateInterruptionRouter;
  updateLock?: { setProcessGroup(pid: number | null): void; setStep(step: string): void };
}
