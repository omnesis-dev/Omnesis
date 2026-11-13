// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { planScopeRefresh } from "@omnesis/source-sdk";
import { withoutGmailLabelScopeCursor } from "./gmail-scope-labels.js";
import type { SyncOptions, SyncResult } from "@omnesis/source-sdk";
import type { GmailSyncCursor } from "./gmail.js";

/** A new metadata cut rotates the required epoch before publishing any observations. */
export function prepareGmailScopeEpoch(
  state: GmailSyncCursor,
  opts?: SyncOptions,
): { state: GmailSyncCursor; handshake?: SyncResult } {
  const plan = planScopeRefresh(
    state.scopeLabelsCut,
    opts?.scopeRefreshEpochs?.label,
    opts?.scopeFactsSupported === true && opts.scopeRefreshEpochsSupported === true,
    opts?.run?.role,
    opts?.scopeRefreshRequestIds?.label,
    opts?.scopeRefreshActorId,
  );
  if (!plan.bookmark) {
    const { scopeLabelsCut: _cut, ...legacyState } = state;
    return { state: legacyState };
  }
  const bootstrap = state.phase === "bootstrap" || !state.historyId;
  if (plan.restart)
    return {
      state,
      handshake: {
        documents: [],
        deletedExternalIds: [],
        hasMore: plan.continueImmediately,
        cursor: {
          ...withoutGmailLabelScopeCursor(state),
          scopeLabelsCut: plan.bookmark,
          ...(bootstrap ? { scopeLabelsBootstrap: true } : {}),
        },
        scopeUpdates: {
          readiness: [{ kind: "label", complete: false }],
          refreshes: [
            {
              kind: "label",
              active: true,
              epoch: plan.epoch,
              restart: true,
              requestId: plan.bookmark?.requestId,
            },
          ],
        },
      },
    };
  if (
    plan.scan &&
    (state.scopeLabelsCut?.epoch !== plan.epoch ||
      state.scopeLabelsCut?.restarting ||
      state.scopeLabelsCut?.authority !== plan.bookmark.authority)
  )
    return {
      state: {
        ...withoutGmailLabelScopeCursor(state),
        scopeLabelsCut: plan.bookmark,
        ...(bootstrap ? { scopeLabelsBootstrap: true } : {}),
      },
    };
  return { state: { ...state, scopeLabelsCut: plan.bookmark } };
}

/** Label proofs and the exact epoch release travel in the same atomic source page. */
export function finalizeGmailScopeEpoch(
  state: GmailSyncCursor,
  result: SyncResult,
  refreshPage: boolean,
  supported: boolean,
): void {
  const cut = state.scopeLabelsCut;
  if (!supported || !cut) return;
  const completed =
    (refreshPage &&
      result.cursor.scopeLabelsVersion === 1 &&
      result.cursor.scopeLabelsStage === undefined) ||
    (!refreshPage &&
      state.scopeLabelsBootstrapCatchup === true &&
      !result.hasMore &&
      result.cursor.scopeLabelsVersion === 1);
  const restarted =
    refreshPage &&
    state.scopeLabelsStage === "history" &&
    result.cursor.scopeLabelsStage === undefined &&
    result.cursor.scopeLabelsVersion !== 1;
  if (restarted) {
    const plan = planScopeRefresh(
      undefined,
      cut.epoch,
      true,
      cut.authority,
      undefined,
      cut.actorId,
    );
    result.cursor = {
      ...withoutGmailLabelScopeCursor(result.cursor as GmailSyncCursor),
      scopeLabelsCut: plan.bookmark,
    };
    if (plan.controls)
      result.scopeUpdates = {
        ...result.scopeUpdates,
        refreshes: [
          ...(result.scopeUpdates?.refreshes ?? []).filter((item) => item.kind !== "label"),
          {
            kind: "label",
            active: true,
            epoch: cut.epoch,
            restart: true,
            requestId: plan.bookmark?.requestId,
          },
        ],
      };
  } else {
    result.cursor = {
      ...result.cursor,
      scopeLabelsCut: { ...cut, ...(completed ? { completed: true } : {}) },
    };
    if (completed && cut.authority === "holder")
      result.scopeUpdates = {
        ...result.scopeUpdates,
        refreshes: [
          ...(result.scopeUpdates?.refreshes ?? []).filter((item) => item.kind !== "label"),
          { kind: "label", active: false, epoch: cut.epoch },
        ],
      };
  }
  if (cut.authority === "member" && result.scopeUpdates) {
    const { readiness: _ready, refreshes: _refresh, ...withoutControls } = result.scopeUpdates;
    result.scopeUpdates = withoutControls;
  }
  for (const document of result.documents) {
    const facts = document.metadata.scopeFacts;
    if (facts?.complete.includes("label"))
      document.metadata.scopeFacts = {
        ...facts,
        refreshEpochs: { ...facts.refreshEpochs, label: cut.epoch },
      };
  }
  for (const update of result.scopeUpdates?.documents ?? [])
    if (update.kinds.includes("label") && update.facts.complete.includes("label"))
      update.facts = {
        ...update.facts,
        refreshEpochs: { ...update.facts.refreshEpochs, label: cut.epoch },
      };
}
