// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's process launcher: a small Node process, forked once at boot
 * before the gateway opens its stores and models, that starts external
 * programs on the gateway's behalf.
 *
 * Starting a program forks the process that asks for it, and the fork copies
 * that process's memory mappings synchronously on its event loop. For the
 * gateway, with gigabytes of database caches, worker heaps and models mapped,
 * that copy takes hundreds of milliseconds to over a second per program, and
 * every request waits for it. Forking from this process costs a few
 * milliseconds instead.
 *
 * The host lives exactly as long as its IPC channel to the gateway. It ignores
 * SIGINT and SIGTERM, which a terminal or service manager sends to the whole
 * process group when the gateway stops, so programs keep running while the
 * gateway drains; when the gateway disconnects or dies, the host kills every
 * program it started and exits.
 *
 * Protocol, over the IPC channel with advanced serialization (byte arrays
 * travel without encoding):
 *   gateway → host  `{ type: "run", id, command, args, opts }`, `{ type: "kill", id }`
 *   host → gateway  `{ type: "ready" }`, `{ type: "started", id, pid }`, `{ type: "result", id, result }`
 */

import {
  killProcessGroup,
  runChild,
  type ProcessResult,
  type RunProcessOptions,
} from "../process-launcher/run-child.js";

export type LauncherRequest =
  | {
      type: "run";
      id: number;
      command: string;
      args: string[];
      opts: Omit<RunProcessOptions, "signal">;
    }
  | { type: "kill"; id: number };

export type LauncherReply =
  | { type: "ready" }
  | { type: "started"; id: number; pid: number }
  | { type: "result"; id: number; result: ProcessResult };

const running = new Map<number, { abort: AbortController; pid?: number }>();

function send(reply: LauncherReply): void {
  if (process.connected) process.send?.(reply);
}

process.on("message", (message: LauncherRequest) => {
  if (message.type === "kill") {
    running.get(message.id)?.abort.abort();
    return;
  }
  const entry: { abort: AbortController; pid?: number } = { abort: new AbortController() };
  running.set(message.id, entry);
  void runChild(
    message.command,
    message.args,
    { ...message.opts, signal: entry.abort.signal },
    (pid) => {
      entry.pid = pid;
      send({ type: "started", id: message.id, pid });
    },
  ).then((result) => {
    running.delete(message.id);
    send({ type: "result", id: message.id, result });
  });
});

process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

// The gateway is gone: nobody will read these programs' output.
process.on("disconnect", () => {
  for (const { pid } of running.values()) if (pid !== undefined) killProcessGroup(pid);
  process.exit(0);
});

send({ type: "ready" });
