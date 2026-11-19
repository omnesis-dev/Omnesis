// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ChildProcess } from "node:child_process";

const SHUTDOWN_MESSAGE = "omnesis.parent-shutdown";

/**
 * Accept shutdown only through an inherited Node parent channel. Standalone
 * processes expose no listener or network surface; unrelated IPC messages are
 * ignored. The owner supplies the same coordinated shutdown used by signals.
 */
export function installParentShutdownHandler(
  shutdown: () => void,
  parent: Pick<NodeJS.Process, "on" | "removeListener" | "send"> = process,
): () => void {
  if (typeof parent.send !== "function") return () => {};
  const onMessage = (message: unknown): void => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return;
    const control = message as Record<string, unknown>;
    if (control.type === SHUTDOWN_MESSAGE && control.version === 1) shutdown();
  };
  parent.on("message", onMessage);
  return () => {
    parent.removeListener("message", onMessage);
  };
}

/** Whether the inherited parent channel accepted a graceful shutdown request. */
export function requestChildShutdown(child: ChildProcess): Promise<boolean> {
  if (!child.connected || typeof child.send !== "function") return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      child.send({ type: SHUTDOWN_MESSAGE, version: 1 }, (error: Error | null) =>
        resolve(error === null),
      );
    } catch {
      resolve(false);
    }
  });
}
