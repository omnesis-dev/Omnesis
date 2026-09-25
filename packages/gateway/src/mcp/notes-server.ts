// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { fromJsonSchema, type McpServer } from "@modelcontextprotocol/server";
import { zodToJsonSchema } from "@omnesis/agent";
import { createNoteBody, type CreateNoteBody } from "../http/schemas/notes.js";

export const NOTES_MCP_INSTRUCTIONS =
  "Use add_note when the user asks to tell Omnesis, remember something, or save a note. " +
  "This writes to the same quick-capture notes as Tell Omnesis in the portal and mobile apps. " +
  "Capture only the information the user intends to save, preserving their meaning. " +
  "Provide a UUID id and reuse it when retrying the same capture; a new note needs a new id. " +
  "Include capture time, time zone and location only when available; never guess them. " +
  "Omnesis records the authenticated principal's identity automatically. Notes access permits " +
  "adding notes only; it does not grant reading, editing, deleting, or Answer or Direct access.";

export type McpNoteInput = Omit<CreateNoteBody, "surface" | "deviceId">;
export interface McpNoteReceipt {
  id: string;
  day: string;
  capturedAt: string;
  receivedAt: string | null;
}

/** Stable across token refresh, isolated from every other credential and capture surface. */
export function scopedNoteId(principalId: string, credentialId: string, id: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(["mcp-note", principalId, credentialId, id]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function registerNotesMcpTool(
  server: McpServer,
  capture: (input: McpNoteInput, signal: AbortSignal) => Promise<McpNoteReceipt>,
): void {
  const schema = zodToJsonSchema(createNoteBody) as Record<string, unknown>;
  const properties = { ...(schema.properties as Record<string, unknown>) };
  delete properties.surface;
  delete properties.deviceId;
  server.registerTool(
    "add_note",
    {
      title: "NOTES — Add a note",
      description: NOTES_MCP_INSTRUCTIONS,
      inputSchema: fromJsonSchema({ ...schema, properties } as Parameters<
        typeof fromJsonSchema
      >[0]),
      outputSchema: fromJsonSchema({
        type: "object",
        properties: {
          id: { type: "string" },
          day: { type: "string" },
          capturedAt: { type: "string" },
          receivedAt: { type: ["string", "null"] },
        },
        required: ["id", "day", "capturedAt", "receivedAt"],
        additionalProperties: false,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, context) => {
      const parsed = createNoteBody.safeParse(args);
      if (
        !parsed.success ||
        parsed.data.surface !== undefined ||
        parsed.data.deviceId !== undefined
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Invalid note. Supply nonblank text (at most 8192 characters), an optional UUID id, and only known capture metadata. Time zone and offset, and latitude and longitude, must be supplied together.",
            },
          ],
          isError: true,
        };
      }
      try {
        const receipt = await capture(parsed.data, context.mcpReq.signal);
        return {
          content: [{ type: "text" as const, text: "Note saved to Omnesis." }],
          structuredContent: { ...receipt },
        };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: "Omnesis could not confirm the note capture. Retry with the same id; if access changed, reconnect with Notes access.",
            },
          ],
          isError: true,
        };
      }
    },
  );
}
