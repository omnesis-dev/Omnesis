// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Acknowledgement payloads the collector sends back over the device socket.
 *
 * They live here, apart from the command switch, so tests can exercise the
 * real payload rather than a transcription of it. `CommandHandler` is typed
 * `(command) => Promise<unknown>`, so nothing compiles these against the
 * response schemas the gateway validates them with — a drift between the two
 * surfaces as "invalid <command> response payload" on a command that actually
 * succeeded, which reads as a failure and is not one.
 */

import type { WsResponsePayload } from "@omnesis/core";

/**
 * Answer a `source.removed` command.
 *
 * `deleted` is the list of source ids that were removed, not a count of the
 * documents deleted with them — the document total is worth logging, but it
 * does not belong in this field.
 */
export function buildSourceRemovedAck(args: {
  sourceId: string;
  failures: Array<{ key: string; error: string }>;
}): WsResponsePayload<"source.removed"> {
  return {
    ok: args.failures.length === 0,
    applied: true,
    deleted: [args.sourceId],
    ...(args.failures.length > 0 ? { failures: args.failures } : {}),
  };
}
