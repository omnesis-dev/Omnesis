// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { safeJsonParse, type ChatMessage } from "./backend.js";
import {
  serializeToolResultForModel,
  type ToolResultSerializationOptions,
} from "./tool-result-text.js";

/**
 * Render a canonical transcript as one user message, for runtimes that start
 * every turn on a fresh thread of their own (Codex app-server, Claude Code)
 * and so cannot take Omnesis' history as native provider messages.
 */
export function renderTranscriptUserInput(
  history: ReadonlyArray<ChatMessage>,
  userMessage: string,
  serialization: ToolResultSerializationOptions = {},
): string {
  if (history.length === 0) return userMessage;

  const lines = ["Conversation so far:"];
  for (const msg of history) {
    if (msg.role === "user") {
      for (const part of msg.parts) {
        if (part.kind === "text") lines.push(`User: ${part.text}`);
        if (part.kind === "tool_result") {
          lines.push(
            `Tool result ${part.toolCallId}: ${serializeToolResultForModel(part.result, serialization)}`,
          );
        }
      }
    } else {
      for (const part of msg.parts) {
        if (part.kind === "text") lines.push(`Assistant: ${part.text}`);
        if (part.kind === "thinking") lines.push(`Assistant reasoning summary: ${part.text}`);
        if (part.kind === "tool_use") {
          lines.push(`Assistant called ${part.tool}: ${safeJsonStringify(part.args)}`);
        }
      }
    }
  }
  lines.push("");
  lines.push("New user message:");
  lines.push(userMessage);
  return lines.join("\n");
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(safeJsonParse(String(value)));
  }
}
