// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { WsCommand } from "@omnesis/core";
import type { CommandDispatch } from "./ws-command-dispatch.js";

/** Commands, including reconnect snapshots and auth, need a fresh peer verdict. */
export function createGatewayCommandHandler(
  requireSourceContract: () => Promise<void>,
  dispatchers: ReadonlyArray<Pick<CommandDispatch, "handle">>,
): (command: WsCommand) => Promise<unknown> {
  return async (command) => {
    // Keep repair and diagnostics reachable when source traffic is refused.
    if (command.type !== "device.update" && command.type !== "device.doctor") {
      await requireSourceContract();
    }
    for (const dispatcher of dispatchers) {
      const result = dispatcher.handle(command);
      if (result !== undefined) return result;
    }
    throw new Error(`Unknown command: ${command.type}`);
  };
}
