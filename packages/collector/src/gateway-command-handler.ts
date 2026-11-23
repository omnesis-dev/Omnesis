// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { WsCommand } from "@omnesis/core";
import type { CommandDispatch } from "./ws-command-dispatch.js";

/**
 * Commands, including reconnect snapshots and auth, need a fresh peer verdict,
 * and reach their handlers in the order the gateway sent them.
 *
 * Each command starts its own contract check as soon as it arrives, but those
 * checks are independent requests that can finish in any order. A command
 * waits for the one before it to have been handed to its handler, so a check
 * that answers late cannot let a later command run first: the connect-time
 * `sources.snapshot` applied after a `source.add` that followed it would read
 * as the source being reassigned while it was added, and an older snapshot
 * applied after a newer one would unregister a source the gateway still
 * assigns here. Only the hand-off is ordered; handlers still run concurrently.
 */
export function createGatewayCommandHandler(
  requireSourceContract: () => Promise<void>,
  dispatchers: ReadonlyArray<Pick<CommandDispatch, "handle">>,
): (command: WsCommand) => Promise<unknown> {
  const dispatch = (command: WsCommand): unknown => {
    for (const dispatcher of dispatchers) {
      const result = dispatcher.handle(command);
      if (result !== undefined) return result;
    }
    throw new Error(`Unknown command: ${command.type}`);
  };
  // Settles once the latest admitted command has been handed to its handler,
  // whether its check passed or not.
  let previousHandedOff: Promise<void> = Promise.resolve();
  return async (command) => {
    // Keep repair and diagnostics reachable when source traffic is refused.
    if (command.type === "device.update" || command.type === "device.doctor") {
      return dispatch(command);
    }
    const check = requireSourceContract();
    // Observed here so a refusal that settles while an earlier command is
    // still waiting is not reported as unhandled; it is awaited below.
    check.catch(() => {});
    let result: unknown;
    const handedOff = previousHandedOff.then(async () => {
      await check;
      result = dispatch(command);
    });
    previousHandedOff = handedOff.catch(() => {});
    await handedOff;
    return result;
  };
}
