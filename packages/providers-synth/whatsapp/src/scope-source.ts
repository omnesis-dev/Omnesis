// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  personMention,
  syncFromFixture,
  withFixtureScopeRefresh,
  impairEntries,
} from "@omnesis/providers-synth-common";
import { conversationScopeWork, SOURCE_SCOPE_MAX_PAGE_WORK } from "@omnesis/source-sdk";
import { personIdentifiers } from "@omnesis/types";
import { mapChat } from "./fixtures.js";
import type { DailyChatEntry } from "./fixtures.js";
import type {
  DocumentInput,
  PersonMention,
  ProviderId,
  SourceId,
  SourceScopeConversationUpdate,
} from "@omnesis/types";
import type { FixtureScopeRevision } from "@omnesis/providers-synth-common";

/** Explicit fixture rosters are native source assertions, independent of people graph edits. */
export function createChatFixtureSource(
  entries: DailyChatEntry[],
  context: { sourceId: SourceId; providerId: ProviderId },
) {
  let ready = true;
  const labels = new Map<string, string>();
  let native: Array<{ id: string; participants: PersonMention[]; observedAt: string }> = [];
  const updates = (
    epoch: string | undefined,
    revision: FixtureScopeRevision,
  ): SourceScopeConversationUpdate[] =>
    native.map((row) => ({
      ...row,
      mode: "snapshot",
      revision,
      ...(epoch ? { refreshEpoch: epoch } : {}),
    }));
  return withFixtureScopeRefresh(
    {
      sync(cursor) {
        return Promise.resolve(
          syncFromFixture(entries, cursor, (entry) => mapChat(entry, context), {
            sourceId: context.sourceId,
          }),
        );
      },
    },
    {
      sourceId: context.sourceId,
      kind: "participant",
      fingerprint() {
        const visible = impairEntries(entries, context.sourceId, (entry) => entry.externalId);
        ready = visible.snapshotAllowed && !visible.partitioned;
        const latest = new Map<string, DailyChatEntry>();
        for (const entry of entries) {
          const previous = latest.get(entry.chatId);
          if (
            !previous ||
            entry.date > previous.date ||
            (entry.date === previous.date && entry.externalId > previous.externalId)
          )
            latest.set(entry.chatId, entry);
        }
        const readable = new Set(visible.visible.map((entry) => entry.externalId));
        for (const [id, entry] of latest)
          if (visible.partitioned || !readable.has(entry.externalId)) latest.delete(id);
        labels.clear();
        for (const entry of latest.values()) labels.set(entry.chatId, entry.chatTitle);
        native = [...latest.values()]
          .sort((a, b) => a.chatId.localeCompare(b.chatId))
          .map((entry) => {
            const people = [
              ...new Set(["self", ...(entry.participants ?? [entry.counterparty])]),
            ].map((ref) => personMention(ref, "participant"));
            const bounded: PersonMention[] = [];
            let work = 0;
            let truncated = false;
            for (const person of people) {
              const ids = personIdentifiers(person);
              if (ids.length > 16) truncated = true;
              const identifiers = ids.slice(0, 16);
              const cost =
                1 + identifiers.length + identifiers.filter((id) => id.kind === "email").length;
              if (bounded.length >= 4095 || work + cost > SOURCE_SCOPE_MAX_PAGE_WORK - 1) {
                truncated = true;
                break;
              }
              bounded.push({
                name: person.name,
                isSelf: person.isSelf,
                role: "participant",
                identifiers,
              });
              work += cost;
            }
            if (truncated) bounded.push({ role: "participant", identifiers: [] });
            return {
              id: entry.chatId,
              participants: bounded,
              observedAt: entry.messages.at(-1)?.at ?? `${entry.date}T00:00:00Z`,
            };
          });
        return JSON.stringify({ native, ready, labels: [...labels] });
      },
      rows(epoch, revision) {
        return updates(epoch, revision).map((update) => ({
          work: 1 + conversationScopeWork(update),
          updates: {
            conversations: [update],
            entities: [
              { kind: "conversation", id: update.id, label: labels.get(update.id) ?? update.id },
            ],
          },
        }));
      },
      decorate(document: DocumentInput, epoch, revision) {
        if (document.metadata.documentType !== "conversation") return;
        const id = document.metadata.extra?.conversationId;
        const snapshot = updates(epoch, revision).find((update) => update.id === id);
        if (snapshot)
          document.metadata.extra = { ...document.metadata.extra, scopeConversation: snapshot };
      },
      ready: () => ready,
    },
  );
}
