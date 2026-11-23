// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What an agent the owner connected at an address hears from `/mcp` once the
 * owner turns MCP off there: an MCP server with no tools whose every answer
 * says why. A stranger never reaches it; see `http/mcp-address-gate.ts`.
 *
 * The reason travels where MCP clients pass it on to the model and the person
 * rather than replacing it with a generic failure. Every reply is an ordinary
 * HTTP 200 MCP exchange, since hosted clients report a failed HTTP status as an
 * internal error without its body. A tool call is answered as a tool execution
 * error (`isError`), which the MCP specification asks clients to give the
 * model; listing tools is a protocol error carrying the same message, so no
 * client caches an empty tool list; and connecting succeeds with the message as
 * the server's instructions, so a client that connects before each call still
 * reaches the tool call.
 */

import {
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { createLogger, readPackageVersion } from "@omnesis/core";

const GATEWAY_VERSION = readPackageVersion(import.meta.url);
const log = createLogger("gateway:mcp-address-off");

/** Why an agent connected at this address gets nothing, and what the person can do about it. */
export const MCP_ADDRESS_OFF_MESSAGE =
  "MCP is turned off for this address in the gateway's settings (Settings → Connectivity → MCP server). " +
  "Ask the owner to turn it on, or connect at another address.";

/** The largest request body the server reads, as the gateway's own MCP endpoint allows. */
const MAX_BODY_BYTES = 64 * 1024;

export function createMcpAddressOffHandler(): McpHttpHandler {
  return createMcpHandler(
    () => {
      const server = new Server(
        { name: "omnesis", version: GATEWAY_VERSION },
        { capabilities: { tools: { listChanged: false } }, instructions: MCP_ADDRESS_OFF_MESSAGE },
      );
      server.setRequestHandler("tools/list", () => {
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, MCP_ADDRESS_OFF_MESSAGE);
      });
      server.setRequestHandler("tools/call", () => ({
        content: [{ type: "text" as const, text: MCP_ADDRESS_OFF_MESSAGE }],
        isError: true,
      }));
      return server;
    },
    {
      legacy: "stateless",
      maxRequestBodySize: MAX_BODY_BYTES,
      maxSubscriptions: 0,
      onerror: (error) =>
        log.debug(`MCP protocol error on an address MCP is off on (${error.name})`),
    },
  );
}
