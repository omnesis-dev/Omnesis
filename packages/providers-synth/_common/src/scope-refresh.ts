// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import {
  isScopeRefreshBookmark,
  planScopeRefresh,
  SOURCE_SCOPE_PAGE_WORK,
} from "@omnesis/source-sdk";
import type { ScopeRefreshBookmark, SourceInstance, SyncCursor } from "@omnesis/source-sdk";
import type { DocumentInput, SourceScopeUpdates } from "@omnesis/types";

interface Observation {
  digest: string;
  sequence: number;
}
interface NativeCursor extends SyncCursor {
  scopeFixtureObservation?: Observation;
  scopeFixtureInitialPulse?: string;
  scopeFixtureRefresh?: { bookmark: ScopeRefreshBookmark; digest: string };
}
export interface FixtureScopeRevision {
  epoch: string;
  sequence: number;
}
export interface FixtureScopeRow {
  work: number;
  updates: Pick<SourceScopeUpdates, "documents" | "conversations" | "entities">;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function clear(cursor: NativeCursor): NativeCursor {
  const { scopeFixtureRefresh: _refresh, ...content } = cursor;
  return content;
}
function merge(rows: readonly FixtureScopeRow[]): SourceScopeUpdates {
  return {
    documents: rows.flatMap((row) => row.updates.documents ?? []),
    conversations: rows.flatMap((row) => row.updates.conversations ?? []),
    entities: rows.flatMap((row) => row.updates.entities ?? []),
  };
}

/** Only orchestration is shared; every native identifier and metadata shape is provider-owned. */
export function withFixtureScopeRefresh<TCursor extends SyncCursor>(
  source: SourceInstance<TCursor>,
  contract: {
    sourceId: string;
    kind: "participant" | "label";
    fingerprint(): string;
    rows(epoch: string | undefined, revision: FixtureScopeRevision): FixtureScopeRow[];
    decorate(
      document: DocumentInput,
      epoch: string | undefined,
      revision: FixtureScopeRevision,
    ): void;
    ready(): boolean;
    replaceEntityKinds?: SourceScopeUpdates["replaceEntityKinds"];
  },
): SourceInstance<TCursor> {
  return {
    ...source,
    async sync(cursor, options) {
      let state: NativeCursor = cursor ?? {};
      const digest = hash(contract.fingerprint());
      const old = state.scopeFixtureObservation;
      const observation: Observation = {
        digest,
        sequence:
          old &&
          /^[a-f0-9]{64}$/.test(old.digest) &&
          Number.isSafeInteger(old.sequence) &&
          old.sequence > 0
            ? old.sequence + Number(old.digest !== digest)
            : 1,
      };
      const revision = { epoch: hash(contract.sourceId), sequence: observation.sequence };
      const supported = options?.scopeFactsSupported === true;
      const nativeRows = supported
        ? contract.rows(options?.scopeRefreshEpochs?.[contract.kind], revision)
        : [];
      const previous = state.scopeFixtureRefresh;
      const previousAfter = previous?.bookmark?.after;
      const validOffset =
        previousAfter === undefined ||
        (/^[0-9]{1,10}$/.test(previousAfter) && Number(previousAfter) <= nativeRows.length);
      const bookmark =
        previous?.digest === digest && validOffset && isScopeRefreshBookmark(previous.bookmark)
          ? previous.bookmark
          : undefined;
      const plan = planScopeRefresh(
        bookmark,
        options?.scopeRefreshEpochs?.[contract.kind],
        supported && options.scopeRefreshEpochsSupported === true,
        options?.run?.role,
        options?.scopeRefreshRequestIds?.[contract.kind],
        options?.scopeRefreshActorId,
      );
      state = { ...clear(state), ...(supported ? { scopeFixtureObservation: observation } : {}) };
      if (plan.bookmark) state.scopeFixtureRefresh = { bookmark: plan.bookmark, digest };
      const pulse = hash(`${contract.sourceId}:${options?.scopeRefreshActorId ?? ""}:${digest}`);
      if (
        supported &&
        options?.scopeRefreshEpochsSupported &&
        !plan.epoch &&
        options.run?.role !== "member" &&
        state.scopeFixtureInitialPulse !== pulse
      ) {
        state.scopeFixtureInitialPulse = pulse;
        return {
          documents: [],
          deletedExternalIds: [],
          cursor: state as TCursor,
          hasMore: true,
          scopeUpdates: {
            refreshes: [{ kind: contract.kind, active: true, requestId: randomUUID() }],
            readiness: [{ kind: contract.kind, complete: false }],
          },
        };
      }
      if (!options?.scopeRefreshEpochsSupported) delete state.scopeFixtureInitialPulse;
      if (plan.restart)
        return {
          documents: [],
          deletedExternalIds: [],
          cursor: state as TCursor,
          hasMore: plan.continueImmediately,
          scopeUpdates: {
            refreshes: [
              {
                kind: contract.kind,
                active: true,
                epoch: plan.epoch,
                restart: true,
                requestId: plan.bookmark?.requestId,
              },
            ],
          },
        };
      if (plan.scan) {
        const rows = nativeRows;
        const after = plan.bookmark?.after;
        const offset = after && /^[0-9]{1,10}$/.test(after) ? Number(after) : 0;
        let end = Math.min(offset, rows.length);
        let work = 0;
        while (end < rows.length && end - offset < 100) {
          const cost = Math.max(1, rows[end]!.work);
          if (end > offset && work + cost > SOURCE_SCOPE_PAGE_WORK) break;
          work += cost;
          end++;
        }
        const done = end === rows.length;
        state.scopeFixtureRefresh = {
          digest,
          bookmark: { ...plan.bookmark!, after: String(end), completed: done },
        };
        return {
          documents: [],
          deletedExternalIds: [],
          cursor: state as TCursor,
          hasMore: true,
          scopeUpdates: {
            ...merge(rows.slice(offset, end)),
            ...(offset === 0 && contract.replaceEntityKinds
              ? { replaceEntityKinds: contract.replaceEntityKinds }
              : {}),
            ...(plan.controls && done
              ? {
                  refreshes: [{ kind: contract.kind, active: false, epoch: plan.epoch }],
                  readiness: [{ kind: contract.kind, complete: contract.ready() }],
                }
              : {}),
          },
        };
      }
      const result = await source.sync(state as TCursor, options);
      if (options?.run?.role === "member" && result.scopeUpdates) {
        const { refreshes: _refresh, readiness: _ready, ...updates } = result.scopeUpdates;
        result.scopeUpdates = updates;
      }
      if (supported)
        for (const document of result.documents) contract.decorate(document, plan.epoch, revision);
      result.cursor = {
        ...result.cursor,
        ...(supported ? { scopeFixtureObservation: observation } : {}),
        ...(state.scopeFixtureRefresh ? { scopeFixtureRefresh: state.scopeFixtureRefresh } : {}),
      };
      if (!plan.bookmark) result.cursor = clear(result.cursor) as TCursor;
      return result;
    },
  };
}
