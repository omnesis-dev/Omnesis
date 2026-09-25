// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  normalizeDanglingUserTurn,
  paginateConversations,
  paginateVisibleConversationMessages,
  type ConversationListOptions,
  type ConversationListPage,
  type ConversationListSnapshot,
  type ConversationMessagePage,
} from "./service.js";
import type {
  ConversationRecord,
  ConversationStore,
  ConversationSummary,
} from "./conversation-store.js";

/** Backend-independent read access to durable agent conversations. */
export interface ConversationReader {
  listConversationPage(options?: ConversationListOptions): Promise<ConversationListPage>;
  loadConversation(id: string): Promise<ConversationRecord | null>;
  listConversationMessages(
    id: string,
    options: { limit: number; before?: number },
  ): Promise<ConversationMessagePage | null>;
}

/** Reads persisted transcripts without requiring an inference backend. */
export class StoredConversationReader implements ConversationReader {
  private readonly listSnapshots = new Map<string, ConversationListSnapshot>();

  constructor(
    private readonly store: ConversationStore,
    private readonly listSummaries: () => Promise<ConversationSummary[]> = () => store.list(),
  ) {}

  async listConversationPage(options: ConversationListOptions = {}): Promise<ConversationListPage> {
    return paginateConversations(await this.listSummaries(), options, this.listSnapshots);
  }

  async loadConversation(id: string): Promise<ConversationRecord | null> {
    const record = await this.store.load(id);
    return record ? normalizeDanglingUserTurn(record) : null;
  }

  async listConversationMessages(
    id: string,
    options: { limit: number; before?: number },
  ): Promise<ConversationMessagePage | null> {
    const record = await this.loadConversation(id);
    if (!record) return null;
    return {
      ...paginateVisibleConversationMessages(
        record.messages,
        record.origin,
        options.limit,
        options.before,
      ),
      model: record.model,
      backend: record.backend,
      ...(record.origin ? { origin: record.origin } : {}),
      ...(record.terminalFailure ? { terminalFailure: record.terminalFailure } : {}),
      ...(record.lastTurnFailure ? { lastTurnFailure: record.lastTurnFailure } : {}),
    };
  }
}
