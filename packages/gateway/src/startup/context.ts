// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { GatewayLock, OwnedProcessCleanup, OwnedProcessShutdownFence } from "@omnesis/core";
import type { HostedProcessLauncher } from "../process-launcher/index.js";
import type { TlsBundle } from "../tls.js";
import type { StartupManager } from "./manager.js";
import type { StartupServer } from "./server.js";

export interface GatewayBootContext {
  configDir: string;
  port: number;
  startedAt: number;
  launcher: HostedProcessLauncher;
  lock: GatewayLock;
  tls: TlsBundle;
  listener: StartupServer;
  startup: StartupManager;
  signal: AbortSignal;
  ownedProcesses: OwnedProcessShutdownFence;
  ownCleanup<T extends OwnedProcessCleanup>(participant: T): T;
  abortStartup(): void;
  fail(error: unknown): void;
  track<T>(operation: Promise<T>): Promise<T>;
  setShutdown(shutdown: (exitCode?: number) => Promise<void>): void;
}
