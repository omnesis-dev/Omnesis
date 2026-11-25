// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** A disappearing owner invokes this process's ordinary graceful-shutdown signal path. */
export function installDesktopParentLifetime(): () => void {
  if (typeof process.send !== "function") return () => {};
  const disconnected = () => {
    process.kill(process.pid, "SIGTERM");
  };
  process.once("disconnect", disconnected);
  if (!process.connected) disconnected();
  return () => process.off("disconnect", disconnected);
}
