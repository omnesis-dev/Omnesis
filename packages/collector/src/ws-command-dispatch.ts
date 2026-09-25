// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Typed dispatch for gateway → collector commands.
 *
 * The socket's `onCommand` callback is typed `(command) => Promise<unknown>`,
 * so a handler answering with the wrong shape is not a compile error — it is a
 * runtime rejection on the gateway, reported as "invalid <command> response
 * payload" for a command that in fact succeeded. Registering through this
 * table instead binds each handler to its command's request AND response
 * schema, so a mismatch fails the build.
 *
 * A registered handler receives a payload already parsed against the request
 * schema, which is what lets a handler body drop the `raw as { … }` casts.
 */

import {
  parseRequestPayload,
  type WsCommandType,
  type WsRequestPayload,
  type WsResponsePayload,
} from "@omnesis/core";

/**
 * Handler for one command: takes its parsed request payload, answers with the
 * matching response payload.
 */
export type TypedCommandHandler<K extends WsCommandType> = (
  payload: WsRequestPayload<K>,
) => WsResponsePayload<K> | Promise<WsResponsePayload<K>>;

export interface CommandDispatch {
  /** Bind a handler to a command. The types must match the schema registry. */
  register<K extends WsCommandType>(type: K, handler: TypedCommandHandler<K>): void;
  /**
   * Run the handler for a command, or return `undefined` when none is
   * registered so the caller can fall through to another dispatcher.
   */
  handle(command: { type: string; payload: unknown }): unknown | Promise<unknown> | undefined;
}

export function createCommandDispatch(): CommandDispatch {
  type Entry = (raw: unknown) => unknown | Promise<unknown>;
  const entries = new Map<WsCommandType, Entry>();

  return {
    register<K extends WsCommandType>(type: K, handler: TypedCommandHandler<K>): void {
      entries.set(type, async (raw: unknown) => {
        const parsed = parseRequestPayload(type, raw);
        if (!parsed.ok) {
          throw new Error(`invalid ${type} payload: ${parsed.error}`);
        }
        return await handler(parsed.value);
      });
    },
    handle(command) {
      const entry = entries.get(command.type as WsCommandType);
      if (!entry) return undefined;
      return entry(command.payload);
    },
  };
}
