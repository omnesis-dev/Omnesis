// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import type { NotificationPublisher } from "../push/broadcast.js";

const log = createLogger("gateway:agent").child("notify");
export const MAX_NOTIFICATION_BODY_CHARS = 175;

export interface ConversationNotification {
  conversationId: string;
  title: string;
  body: string;
}

export function conversationCollapseId(conversationId: string): string {
  return `agent-answer:${conversationId}`;
}

export function clipNotificationBody(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_NOTIFICATION_BODY_CHARS) return collapsed;
  const cut = collapsed.slice(0, MAX_NOTIFICATION_BODY_CHARS - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > MAX_NOTIFICATION_BODY_CHARS - 24 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

export class ConversationNotifier {
  constructor(private readonly publisher: NotificationPublisher) {}

  async notify(notification: ConversationNotification): Promise<void> {
    const results = await this.publisher.publish({
      kind: "conversation",
      title: notification.title || "Omnesis",
      body: clipNotificationBody(notification.body),
      data: { conversationId: notification.conversationId },
      collapseId: conversationCollapseId(notification.conversationId),
    });
    log.info(
      `conversation ${notification.conversationId}: wake accepted by ${results.filter((result) => result.ok).length}/${results.length} device(s)`,
    );
  }
}
