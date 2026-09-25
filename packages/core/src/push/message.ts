// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { assertNever } from "../utils.js";

const titleSchema = z.string().min(1).max(512);
const bodySchema = z.string().max(4096);
const collapseIdSchema = z.string().min(1).max(256);

function message<const Kind extends string, Data extends z.ZodType>(kind: Kind, data: Data) {
  return z
    .object({
      kind: z.literal(kind),
      title: titleSchema,
      body: bodySchema,
      data,
      collapseId: collapseIdSchema,
    })
    .strict();
}

/** Every rendered, gateway-private notification shape, including operator diagnostics. */
export const notificationMessageSchema = z.discriminatedUnion("kind", [
  message("diagnostic", z.object({}).strict()),
  message("agent-answer", z.object({ conversationId: z.string().min(1).max(256) }).strict()),
  message("conversation", z.object({ conversationId: z.string().min(1).max(256) }).strict()),
  message("brief", z.object({ briefId: z.string().min(1).max(256) }).strict()),
  message(
    "watch",
    z
      .object({
        watchId: z.string().min(1).max(256),
        firingKey: z.string().min(1).max(512),
        firingId: z.string().min(1).max(1024).optional(),
        /**
         * The conversation the agent opened about this firing, where it opened
         * one.
         *
         * A firing the agent wrote about has somewhere better to land than the
         * watch that produced it: the thread whose opening sentence the banner
         * is quoting. Absent on a gateway with no agent, and on a firing whose
         * thread could not be written — where the ledger line remains the best
         * a tap can reach.
         */
        conversationId: z.string().min(1).max(256).optional(),
      })
      .strict(),
  ),
  message(
    "needs-auth",
    z
      .object({
        sourceId: z.string().min(1).max(512),
        providerId: z.string().min(1).max(512).optional(),
      })
      .strict(),
  ),
  message(
    "source-permission",
    z
      .object({
        sourceId: z.string().min(1).max(512),
        affectedDeviceId: z.string().min(1).max(256),
        sourceName: z.string().min(1).max(256).optional(),
        affectedDeviceName: z.string().min(1).max(256).optional(),
      })
      .strict(),
  ),
  message("privacy-approval", z.object({ approvalId: z.string().min(1).max(256) }).strict()),
  // Deliberately carries no request id, client name, user code, or grant
  // detail. A phone tap may only open the code-entry surface; authenticated
  // short-code lookup is the boundary that reveals the pending request.
  message("access-authorization", z.object({}).strict()),
]);

export type NotificationMessage = z.infer<typeof notificationMessageSchema>;
export type NotificationKind = NotificationMessage["kind"];

/**
 * Producer-specific navigation data returned only over the paired gateway
 * connection. Keeping this as a tagged union preserves details such as a
 * watch firing key without putting them into the carrier wake.
 */
export const notificationRouteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("diagnostic") }).strict(),
  z
    .object({ kind: z.literal("agent-answer"), conversationId: z.string().min(1).max(256) })
    .strict(),
  z
    .object({ kind: z.literal("conversation"), conversationId: z.string().min(1).max(256) })
    .strict(),
  z.object({ kind: z.literal("brief"), briefId: z.string().min(1).max(256) }).strict(),
  z
    .object({
      kind: z.literal("watch"),
      watchId: z.string().min(1).max(256),
      firingKey: z.string().min(1).max(512),
      firingId: z.string().min(1).max(1024).optional(),
      /** Where the agent wrote about this firing, if it did. */
      conversationId: z.string().min(1).max(256).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("needs-auth"),
      sourceId: z.string().min(1).max(512),
      providerId: z.string().min(1).max(512).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("source-permission"),
      sourceId: z.string().min(1).max(512),
      affectedDeviceId: z.string().min(1).max(256),
      sourceName: z.string().min(1).max(256).optional(),
      affectedDeviceName: z.string().min(1).max(256).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("privacy-approval"), approvalId: z.string().min(1).max(256) })
    .strict(),
  z.object({ kind: z.literal("access-authorization") }).strict(),
]);

export type NotificationRoute = z.infer<typeof notificationRouteSchema>;

/**
 * Private notification content returned to one authenticated device after a
 * content-free carrier wake. `id` is the current lease token, not the stable
 * queue row id, so a stale claimant cannot confirm a later lease.
 */
export const claimedNotificationSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum([
      "diagnostic",
      "agent-answer",
      "conversation",
      "brief",
      "watch",
      "needs-auth",
      "source-permission",
      "privacy-approval",
      "access-authorization",
    ]),
    targetId: z.string().min(1).max(512),
    /** Device that owns the condition, when a reminder may be claimed elsewhere. */
    affectedDeviceId: z.string().min(1).max(256).optional(),
    sourceName: z.string().min(1).max(256).optional(),
    affectedDeviceName: z.string().min(1).max(256).optional(),
    title: titleSchema,
    body: bodySchema,
    collapseId: collapseIdSchema,
    remaining: z.number().int().nonnegative(),
    // Optional while a current phone can still talk to a gateway that predates
    // typed claim routes. Clients fall back to kind + targetId in that case.
    route: notificationRouteSchema.optional(),
  })
  .strict();

export type ClaimedNotification = z.infer<typeof claimedNotificationSchema>;

/** Keep producer-specific data local while exposing one stable claim target. */
export function notificationTargetId(message: NotificationMessage): string {
  switch (message.kind) {
    case "diagnostic":
      return "app";
    case "agent-answer":
    case "conversation":
      return message.data.conversationId;
    case "brief":
      return message.data.briefId;
    case "watch":
      return message.data.watchId;
    case "needs-auth":
      return message.data.sourceId;
    case "source-permission":
      return message.data.sourceId;
    case "privacy-approval":
      return message.data.approvalId;
    case "access-authorization":
      return "access";
    default:
      return assertNever(message);
  }
}

export function notificationRoute(message: NotificationMessage): NotificationRoute {
  switch (message.kind) {
    case "diagnostic":
      return { kind: message.kind };
    case "agent-answer":
      return { kind: message.kind, conversationId: message.data.conversationId };
    case "conversation":
      return { kind: message.kind, conversationId: message.data.conversationId };
    case "brief":
      return { kind: message.kind, briefId: message.data.briefId };
    case "watch":
      return {
        kind: message.kind,
        watchId: message.data.watchId,
        firingKey: message.data.firingKey,
        ...(message.data.firingId === undefined ? {} : { firingId: message.data.firingId }),
        ...(message.data.conversationId === undefined
          ? {}
          : { conversationId: message.data.conversationId }),
      };
    case "needs-auth":
      return {
        kind: message.kind,
        sourceId: message.data.sourceId,
        ...(message.data.providerId === undefined ? {} : { providerId: message.data.providerId }),
      };
    case "source-permission":
      return {
        kind: message.kind,
        sourceId: message.data.sourceId,
        affectedDeviceId: message.data.affectedDeviceId,
        ...(message.data.sourceName === undefined ? {} : { sourceName: message.data.sourceName }),
        ...(message.data.affectedDeviceName === undefined
          ? {}
          : { affectedDeviceName: message.data.affectedDeviceName }),
      };
    case "privacy-approval":
      return { kind: message.kind, approvalId: message.data.approvalId };
    case "access-authorization":
      return { kind: message.kind };
    default:
      return assertNever(message);
  }
}
