// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { planScopeRefresh } from "@omnesis/source-sdk";
import type { ScopeRefreshPlan, SyncOptions, SyncResult } from "@omnesis/source-sdk";
import type { MessageStore } from "./message-store.js";
import type { WhatsAppSyncCursor } from "./types.js";

export type RefreshScopeGroupRosters = (jids: readonly string[]) => Promise<Set<string>>;

/** Bounded source-owned native evidence; a cached roster alone never earns a new cut witness. */
export async function prepareWhatsAppScopeRefresh(
  store: MessageStore,
  state: WhatsAppSyncCursor,
  opts: SyncOptions | undefined,
  refreshNative: RefreshScopeGroupRosters | undefined,
): Promise<{ plan: ScopeRefreshPlan; candidates: string[]; restartPage?: SyncResult }> {
  const scopeEnabled = opts?.scopeFactsSupported === true;
  const previousRefresh =
    state.scopeParticipantRefresh?.storeId === store.storeId
      ? state.scopeParticipantRefresh
      : undefined;
  const scopePlan = planScopeRefresh(
    previousRefresh,
    opts?.scopeRefreshEpochs?.participant,
    scopeEnabled && opts?.scopeRefreshEpochsSupported === true,
    opts?.run?.role,
    opts?.scopeRefreshRequestIds?.participant,
    opts?.scopeRefreshActorId,
  );
  if (!scopeEnabled || !opts?.scopeRefreshEpochsSupported || scopePlan.restart)
    store.resetScopeRefreshWitnesses();
  if (scopePlan.restart)
    return {
      plan: scopePlan,
      candidates: [],
      restartPage: {
        documents: [],
        deletedExternalIds: [],
        cursor: {
          ...state,
          scopeParticipantRefresh: { ...scopePlan.bookmark!, storeId: store.storeId },
        },
        scopeUpdates: {
          refreshes: [
            {
              kind: "participant",
              active: true,
              epoch: scopePlan.epoch,
              restart: true,
              requestId: scopePlan.bookmark?.requestId,
            },
          ],
        },
        hasMore: scopePlan.continueImmediately,
      },
    };
  if (scopePlan.scan && previousRefresh?.epoch !== scopePlan.epoch)
    store.resetScopeRefreshWitnesses();
  const refreshCandidates = scopePlan.scan
    ? store.scopeConversationPage(scopePlan.bookmark?.after ?? "", 201)
    : scopePlan.epoch
      ? store.scopeMembershipCandidates(
          state.storeId === store.storeId ? (state.scopeCommittedSeq ?? 0) : 0,
        )
      : [];
  if (scopePlan.epoch) {
    const unseen = refreshCandidates
      .slice(0, 200)
      .filter((jid) => !store.hasScopeRefreshWitness(jid, scopePlan.epoch!));
    const groups = unseen.filter(
      (jid) => store.getChat(jid)?.isGroup || jid.endsWith("@g.us") || jid.endsWith("@broadcast"),
    );
    let fresh = new Set<string>();
    try {
      fresh = (await refreshNative?.(groups)) ?? fresh;
    } catch {
      /* Keep inaccessible native groups unknown. */
    }
    for (const jid of unseen)
      if (!groups.includes(jid) || fresh.has(jid))
        store.markScopeRefreshWitness(jid, scopePlan.epoch);
  }
  return { plan: scopePlan, candidates: refreshCandidates };
}
