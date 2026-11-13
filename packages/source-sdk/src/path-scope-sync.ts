// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { pathScopeFolders, pathScopeLayoutKey } from "./path-scopes.js";
import { documentScopeParent } from "./scope-facts.js";
import type { PathScopeLayout } from "./path-scopes.js";
import type { SourceInstance } from "./define-source.js";
import type { SyncCursor, SyncResult } from "./source.js";
import type { SourceScopeHierarchyUpdate, SourceScopeUpdates } from "@omnesis/types";

/** A document the source's cursor knows, and the directory it is in. Null is unknown. */
export interface PathScopeEntry {
  externalId: string;
  directory: string | null;
}

/**
 * What has been published, kept in the source's cursor so it is committed
 * with the page that published it.
 */
export interface PathScopeBookmark {
  version: 1;
  /** The layout the published folders were named with. */
  layout: string;
  /** The gateway refresh the publication answers; empty when it asked for none. */
  epoch: string;
  /** The device that published; empty when the host did not name it. */
  actorId: string;
  /** Every document the cursor knew has been published once under the fields above. */
  completed: boolean;
  /** The source has ended a run since a pass was owed, so the pass may read its cursor. */
  observed?: true;
  /** The last document a pass over the whole cursor has published. */
  after?: string;
  /** Documents of an earlier page whose folders did not fit in it. */
  pending?: string[];
}

export interface PathScopeContract<TCursor extends SyncCursor> {
  layout: PathScopeLayout;
  /** Every document `cursor` accounts for, including those of the page that produced it. */
  inventory(cursor: TCursor): Iterable<PathScopeEntry>;
}

/** The cursor key the bookmark is stored under, beside the source's own state. */
export const PATH_SCOPE_CURSOR_KEY = "pathScopes";
/** The gateway accepts 256 folders and 256 documents in one page of folder facts. */
const PAGE_DOCUMENTS = 128;
const PAGE_FOLDERS = 256;
/** Past this many waiting documents a pass over the whole cursor is cheaper to keep. */
const MAX_PENDING = 20_000;

function isBookmark(value: unknown): value is PathScopeBookmark {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    item.version === 1 &&
    typeof item.layout === "string" &&
    typeof item.epoch === "string" &&
    typeof item.actorId === "string" &&
    typeof item.completed === "boolean" &&
    (item.observed === undefined || item.observed === true) &&
    (item.after === undefined || typeof item.after === "string") &&
    (item.pending === undefined ||
      (Array.isArray(item.pending) &&
        item.pending.length <= MAX_PENDING &&
        item.pending.every((id) => typeof id === "string")))
  );
}

/** As many of `entries`, in order, as one page of folder facts holds. */
function hierarchyPage(
  entries: readonly PathScopeEntry[],
  layout: PathScopeLayout,
  refreshEpoch: string | undefined,
): { hierarchy?: SourceScopeHierarchyUpdate; taken: number } {
  const nodes = new Map<string, NonNullable<SourceScopeHierarchyUpdate["nodes"]>[number]>();
  const documents = new Map<string, NonNullable<SourceScopeHierarchyUpdate["documents"]>[number]>();
  let taken = 0;
  for (const entry of entries) {
    if (documents.size >= PAGE_DOCUMENTS) break;
    const folders = entry.directory === null ? null : pathScopeFolders(entry.directory, layout);
    const added = (folders ?? []).filter((folder) => !nodes.has(folder.id));
    if (taken > 0 && nodes.size + added.length > PAGE_FOLDERS) break;
    for (const folder of added)
      nodes.set(folder.id, {
        id: folder.id,
        label: folder.label,
        parentIds: folder.parentId ? [folder.parentId] : [],
        complete: true,
      });
    const { kind: _kind, ...parents } = documentScopeParent(folders?.[0]!.id, refreshEpoch);
    documents.set(entry.externalId, { externalId: entry.externalId, ...parents });
    taken++;
  }
  if (taken === 0) return { taken };
  return {
    taken,
    hierarchy: {
      kind: "folder",
      ...(refreshEpoch ? { refreshEpoch } : {}),
      ...(nodes.size ? { nodes: [...nodes.values()] } : {}),
      documents: [...documents.values()],
    },
  };
}

/** One entry per document, in the order a pass over the cursor publishes them. */
function ordered(entries: Iterable<PathScopeEntry>): PathScopeEntry[] {
  const unique = new Map<string, PathScopeEntry>();
  for (const entry of entries) unique.set(entry.externalId, entry);
  return [...unique.values()].sort((a, b) =>
    a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0,
  );
}

/**
 * Give a source that reads directories a folder filter: every document it
 * emits says which folder it is in, and the folders, with their ancestors,
 * are published to the gateway for the filter editor and for enforcement.
 *
 * The wrapped source only has to say, from its cursor, which document is in
 * which directory. Everything else follows from that:
 *
 *  - a page's documents carry their folder and the page carries those folders,
 *    so a new or moved document is filed where it is as it is stored;
 *  - documents stored before folders were published — by an earlier version,
 *    while the gateway took no folder facts, or under a layout or a gateway
 *    refresh that has since changed — are published in a pass of their own,
 *    without their content being sent again. The pass follows a run of the
 *    source, so it reads a cursor the source has just checked against the
 *    disk, and the run's last page is asked for again once the pass is over;
 *  - a document whose directory is unknown says so, which keeps it out of
 *    reach of any folder filter instead of reading as "in no folder".
 *
 * Folders are only ever added. Several devices may host one source and each
 * publishes the folders it sees; none can tell which folders another still
 * uses, so none retracts one. A folder nothing is in any more matches nothing.
 *
 * The source must not publish a folder hierarchy of its own.
 */
export function withPathScopes<TCursor extends SyncCursor>(
  source: SourceInstance<TCursor>,
  contract: PathScopeContract<TCursor>,
): SourceInstance<TCursor> {
  const layoutKey = pathScopeLayoutKey(contract.layout);
  return {
    ...source,
    async sync(cursor, options) {
      const { [PATH_SCOPE_CURSOR_KEY]: stored, ...own }: SyncCursor = cursor ?? {};
      const content = Object.keys(own).length ? (own as TCursor) : null;
      // A member of a shared source may not publish a hierarchy; the holder does.
      if (options?.scopeHierarchySupported !== true || options.run?.role === "member")
        return source.sync(content, options);

      const epoch = options.scopeRefreshEpochs?.folder;
      const wanted = {
        layout: layoutKey,
        epoch: epoch ?? "",
        actorId: options.scopeRefreshActorId ?? "",
      };
      let bookmark: PathScopeBookmark =
        isBookmark(stored) &&
        stored.layout === wanted.layout &&
        stored.epoch === wanted.epoch &&
        stored.actorId === wanted.actorId
          ? stored
          : { version: 1, ...wanted, completed: false };
      /** Said once a pass ends: the refresh it answered is done and the editor may list folders. */
      const finished: SourceScopeUpdates = {
        ...(epoch ? { refreshes: [{ kind: "folder", active: false, epoch }] } : {}),
        readiness: [{ kind: "folder", complete: true }],
      };
      const withBookmark = (state: TCursor | null): TCursor =>
        ({ ...state, [PATH_SCOPE_CURSOR_KEY]: bookmark }) as unknown as TCursor;

      const passing = content !== null && !bookmark.completed && bookmark.observed === true;
      if (content !== null && (passing || bookmark.pending?.length)) {
        const known = ordered(contract.inventory(content));
        let scopeUpdates: SourceScopeUpdates;
        if (passing) {
          const after = bookmark.after;
          const rest = after === undefined ? known : known.filter((e) => e.externalId > after);
          const page = hierarchyPage(rest, contract.layout, epoch);
          const done = page.taken === rest.length;
          bookmark = done
            ? { version: 1, ...wanted, completed: true }
            : {
                version: 1,
                ...wanted,
                completed: false,
                observed: true,
                after: rest[page.taken - 1]!.externalId,
              };
          scopeUpdates = {
            ...(page.hierarchy ? { hierarchy: page.hierarchy } : {}),
            ...(done ? finished : {}),
          };
        } else {
          const byId = new Map(known.map((entry) => [entry.externalId, entry]));
          const waiting = bookmark.pending!.flatMap((id) => byId.get(id) ?? []);
          const page = hierarchyPage(waiting, contract.layout, epoch);
          const rest = waiting.slice(page.taken).map((entry) => entry.externalId);
          bookmark = {
            version: 1,
            ...wanted,
            completed: bookmark.completed,
            ...(rest.length ? { pending: rest } : {}),
          };
          scopeUpdates = page.hierarchy ? { hierarchy: page.hierarchy } : {};
        }
        return {
          documents: [],
          deletedExternalIds: [],
          cursor: withBookmark(content),
          hasMore: true,
          scopeUpdates,
        };
      }

      const result = await source.sync(content, options);
      const directories = new Map<string, string | null>();
      for (const entry of contract.inventory(result.cursor))
        directories.set(entry.externalId, entry.directory);
      const emitted = new Map<string, PathScopeEntry>();
      for (const document of result.documents) {
        const directory = directories.get(document.externalId) ?? null;
        emitted.set(document.externalId, { externalId: document.externalId, directory });
        document.metadata = {
          ...document.metadata,
          scopeHierarchy: [
            documentScopeParent(
              directory === null ? null : pathScopeFolders(directory, contract.layout)?.[0]!.id,
              epoch,
            ),
          ],
        };
      }
      const entries = [...emitted.values()];
      const page = hierarchyPage(entries, contract.layout, epoch);
      const waiting = entries.slice(page.taken).map((entry) => entry.externalId);
      let ended = false;
      if (bookmark.completed || (content === null && waiting.length === 0)) {
        // A first run has stored nothing, so its pass is over as it starts.
        ended = !bookmark.completed;
        bookmark =
          waiting.length > MAX_PENDING
            ? { version: 1, ...wanted, completed: false }
            : {
                version: 1,
                ...wanted,
                completed: true,
                ...(waiting.length ? { pending: waiting } : {}),
              };
      }
      // A pass is owed. It starts when the source has ended a run, so that
      // what it publishes from the cursor is what the source has just seen on
      // disk and not what an earlier run remembered.
      if (!bookmark.completed)
        bookmark = {
          version: 1,
          ...wanted,
          completed: false,
          ...(result.hasMore ? {} : { observed: true as const }),
        };
      const settled = bookmark.completed && !bookmark.pending;
      const scopeUpdates: SourceScopeUpdates = {
        ...(page.hierarchy ? { hierarchy: page.hierarchy } : {}),
        ...(ended
          ? finished
          : // Restated at the end of every run: a host that cannot report
            // folders withdraws the editor's list when it writes, and this
            // returns it.
            settled && !result.hasMore
            ? { readiness: [{ kind: "folder" as const, complete: true }] }
            : {}),
      };
      const decorated: SyncResult<TCursor> = {
        ...result,
        cursor: withBookmark(result.cursor),
        ...(Object.keys(scopeUpdates).length ? { scopeUpdates } : {}),
      };
      if (settled || result.hasMore) return decorated;
      // Folders still wait to be published, so the run goes on. What a source
      // says only on its last page is said again by the page that ends it.
      const {
        presentExternalIds: _ids,
        presentClaims: _claims,
        watermark: _watermark,
        ...unfinished
      } = decorated;
      return { ...unfinished, hasMore: true };
    },
  };
}
