// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Request-body schema for `POST /agent-messages` — the pushed
 * agent-conversation ingest surface. A harness plugin (OpenClaw / Hermes) reads
 * its own durable transcript and POSTs raw turns; the gateway projects them
 * into day documents via the shared renderer.
 */
import { z } from "zod";

/** Lowercase slug for a harness id / channel id. */
const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "must be a lowercase slug");

/** ISO-8601 string or epoch-milliseconds number. */
const instant = z.union([
  z
    .string()
    .max(64)
    .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date-time"),
  z.number().int().nonnegative(),
]);

const pushedMessage = z
  .object({
    /**
     * Client-supplied idempotency key. A retried push (or a live turn the
     * install-time backfill also read) re-sends the same id and dedups. When
     * omitted the server synthesizes a deterministic id from the content.
     */
    id: z.string().min(1).max(256).optional(),
    harness: slug,
    channel: slug,
    /** Chat id within the channel; empty string for a host-local surface. */
    chatId: z.string().max(256),
    chatName: z.string().max(256).optional(),
    chatType: z.string().max(64).optional(),
    role: z.enum(["user", "assistant"]),
    text: z.string().min(1).max(200_000),
    occurredAt: instant,
  })
  .strict();
export type PushedMessage = z.infer<typeof pushedMessage>;

// POST /agent-messages
export const ingestAgentMessagesBody = z
  .object({
    messages: z.array(pushedMessage).min(1).max(2_000),
  })
  .strict();
export type IngestAgentMessagesBody = z.infer<typeof ingestAgentMessagesBody>;
