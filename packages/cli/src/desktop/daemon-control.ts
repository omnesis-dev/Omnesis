// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { chmod, lstat, mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DesktopProfile } from "./environment.js";

const CONTROL_TIMEOUT_MS = 80_000;
const STOP_COMMAND = "stop\n";
const STOPPED_REPLY = "stopped\n";

/** A short private directory avoids Darwin's small Unix-socket pathname limit. */
export function desktopDaemonSocket(profile: DesktopProfile): string {
  if (process.platform === "win32") throw new Error("Desktop daemon control requires Unix sockets");
  const identity = createHash("sha256").update(profile.configDir).digest("hex").slice(0, 24);
  return join(
    "/tmp",
    `omnesis-desktop-${process.getuid?.() ?? "user"}-${identity}`,
    "control.sock",
  );
}

export async function startDesktopDaemonControl(
  profile: DesktopProfile,
  options: { stop(): void; drained: Promise<void> },
): Promise<{ close(): Promise<void> }> {
  const path = desktopDaemonSocket(profile);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    (process.getuid && parent.uid !== process.getuid())
  )
    throw new Error("The desktop control directory must be private and owned by you");
  try {
    const prior = await lstat(path);
    if (!prior.isSocket() || (process.getuid && prior.uid !== process.getuid()))
      throw new Error("The desktop control path is occupied by an unowned file");
    // The caller holds the runtime's process-identity lease, so an owned socket
    // at this pathname is from a prior supervisor, never another live owner.
    await rm(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const sockets = new Map<Socket, boolean>();
  let stopping = false;
  const server = createServer((socket) => {
    sockets.set(socket, false);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(CONTROL_TIMEOUT_MS, () => socket.destroy());
    let bytes = Buffer.alloc(0);
    let accepted = false;
    socket.on("data", (chunk: Buffer) => {
      if (accepted || bytes.length + chunk.length > STOP_COMMAND.length) {
        socket.destroy();
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      if (!bytes.includes(10)) return;
      if (bytes.toString("utf8") !== STOP_COMMAND) {
        socket.destroy();
        return;
      }
      accepted = true;
      sockets.set(socket, true);
      if (!stopping) {
        stopping = true;
        try {
          options.stop();
        } catch {
          socket.destroy();
          return;
        }
      }
      void options.drained.then(
        () => socket.end(STOPPED_REPLY, () => socket.destroy()),
        () => socket.destroy(),
      );
    });
  });
  server.maxConnections = 4;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  try {
    await chmod(path, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  // An error after registration must not crash a daemon while it is draining.
  server.on("error", () => {});
  return {
    async close() {
      for (const [socket, accepted] of sockets) if (!accepted) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rmdir(directory).catch(() => {});
    },
  };
}

/** Success acknowledges completed draining, never a PID lookup or a signal sent. */
export async function stopDesktopDaemon(
  profile: DesktopProfile,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const operation = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MS)]);
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ path: desktopDaemonSocket(profile), signal: operation });
    let response = Buffer.alloc(0);
    socket.once("connect", () => socket.write(STOP_COMMAND));
    socket.on("data", (chunk: Buffer) => {
      if (response.length + chunk.length > STOPPED_REPLY.length) {
        socket.destroy(new Error("The desktop service returned an invalid stop response"));
        return;
      }
      response = Buffer.concat([response, chunk]);
    });
    socket.once("end", () => {
      socket.destroy();
      if (response.toString("utf8") === STOPPED_REPLY) resolve(true);
      else reject(new Error("The desktop service did not confirm that it stopped"));
    });
    socket.once("error", (error) => {
      if (hasCode(error, "ENOENT") || hasCode(error, "ECONNREFUSED")) resolve(false);
      else reject(error);
    });
  });
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
