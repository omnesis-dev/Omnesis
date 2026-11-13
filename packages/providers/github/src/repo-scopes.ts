// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import {
  documentScopeParent,
  isScopeRefreshBookmark,
  planScopeRefresh,
  syncPage,
} from "@omnesis/source-sdk";
import type {
  ScopeRefreshBookmark,
  SyncCursor,
  SyncOptions,
  SyncResult,
} from "@omnesis/source-sdk";
import type {
  DocumentInput,
  SourceScopeHierarchyParents,
  SourceScopeHierarchyUpdate,
  SourceScopeUpdates,
} from "@omnesis/types";
import type { RestRepoRow } from "./types.js";

/**
 * What a filter on a GitHub source can name, and how every document comes to
 * carry it.
 *
 * The tree has two levels. An owner — a user or an organization — is a root,
 * and each repository hangs beneath the owner that holds it. Both are named by
 * GitHub's own numeric ids, never by name: a renamed repository or
 * organization keeps its id, so a saved filter keeps meaning the same thing,
 * and a repository transferred to another owner moves beneath that owner the
 * moment the listing says so. The names are labels only.
 *
 * A document says which repository it sits in and nothing more; the gateway
 * derives the owner from the tree. A document whose repository this source
 * cannot identify says so, and a filter then withholds it.
 *
 * Documents stored before the gateway asked for these facts, and every stored
 * document when it asks for them again, are attributed without being fetched
 * again: a snapshot cycle already lists the id of every thread and commit of
 * every repository, and while a refresh is under way each listed id is sent
 * with its repository.
 */

type HierarchyNode = NonNullable<SourceScopeHierarchyUpdate["nodes"]>[number];
type HierarchyDocument = NonNullable<SourceScopeHierarchyUpdate["documents"]>[number];

/** Catalogue entries published on one page; the gateway refuses more than 256. */
const MAX_NODES_PER_PAGE = 200;
/**
 * Listed documents after which discovery yields. A listing page holds at most
 * 100, so a page that starts below this stays within the gateway's 256.
 */
const WITNESS_YIELD = 150;
const MAX_LABEL = 512;
/** The bookmark position of a refresh whose snapshot cycle has started. */
const SCANNING = "scan";

export const ownerScopeId = (id: number): string => `owner:${id}`;
export const repoScopeId = (id: number): string => `repo:${id}`;

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
/** Owner and repository names are case-insensitive on GitHub. */
const repoKey = (fullName: string): string => fullName.toLowerCase();

/** The cursor fields that carry the catalogue and its refresh between pages. */
export interface RepoScopeCursor {
  /** The refresh this source is answering, as the shared planner keeps it. */
  scopeReposCut?: ScopeRefreshBookmark;
  /** The gateway has been asked once to open a first refresh. */
  scopeReposAsked?: boolean;
  /** The catalogue snapshot the refresh in flight publishes under. */
  scopeReposSnapshot?: string;
  /** The catalogue as last published: node id to its label and parent. */
  scopeReposNodes?: Record<string, string>;
  /** Repository node id by lower-cased `owner/repo`. */
  scopeReposIds?: Record<string, string>;
  /**
   * Repositories the completed refresh could not list. Their stored documents
   * are still unattributed, and the next snapshot that lists them sends them.
   */
  scopeReposUnlisted?: string[];
}

const CURSOR_FIELDS = [
  "scopeReposCut",
  "scopeReposAsked",
  "scopeReposSnapshot",
  "scopeReposNodes",
  "scopeReposIds",
  "scopeReposUnlisted",
] as const satisfies readonly (keyof RepoScopeCursor)[];

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

/** Whether the scope fields of a stored cursor can be resumed from. */
export function isRepoScopeCursor(cursor: object): boolean {
  const value = cursor as Record<string, unknown>;
  if (value.scopeReposCut !== undefined && !isScopeRefreshBookmark(value.scopeReposCut))
    return false;
  if (value.scopeReposAsked !== undefined && typeof value.scopeReposAsked !== "boolean")
    return false;
  if (
    value.scopeReposSnapshot !== undefined &&
    (typeof value.scopeReposSnapshot !== "string" || !value.scopeReposSnapshot)
  )
    return false;
  if (value.scopeReposNodes !== undefined && !isStringRecord(value.scopeReposNodes)) return false;
  if (value.scopeReposIds !== undefined && !isStringRecord(value.scopeReposIds)) return false;
  return (
    value.scopeReposUnlisted === undefined ||
    (Array.isArray(value.scopeReposUnlisted) &&
      value.scopeReposUnlisted.every((item) => typeof item === "string"))
  );
}

/**
 * The owners and repositories of a listing, owners first.
 *
 * A row without GitHub's ids gets no entry, so its documents stay
 * unattributed. A repository whose owner is not named is published with its
 * place unknown rather than as a root: a root would escape a filter that hides
 * its real owner.
 */
export function repoScopeCatalogue(rows: readonly RestRepoRow[]): {
  nodes: HierarchyNode[];
  ids: Record<string, string>;
} {
  const owners = new Map<string, HierarchyNode>();
  const repos = new Map<string, HierarchyNode>();
  const ids: Record<string, string> = {};
  for (const row of rows) {
    if (!isId(row.id) || typeof row.full_name !== "string" || !row.full_name) continue;
    const id = repoScopeId(row.id);
    const owner = row.owner;
    const ownerId = owner && isId(owner.id) ? ownerScopeId(owner.id) : undefined;
    if (ownerId && !owners.has(ownerId)) {
      const login =
        typeof owner?.login === "string" && owner.login
          ? owner.login
          : row.full_name.split("/")[0]!;
      owners.set(ownerId, {
        id: ownerId,
        label: login.slice(0, MAX_LABEL),
        parentIds: [],
        complete: true,
      });
    }
    repos.set(id, {
      id,
      label: row.full_name.slice(0, MAX_LABEL),
      parentIds: ownerId ? [ownerId] : [],
      complete: ownerId !== undefined,
    });
    ids[repoKey(row.full_name)] = id;
  }
  return { nodes: [...owners.values(), ...repos.values()], ids };
}

const nodeDigest = (node: HierarchyNode): string =>
  JSON.stringify([node.label, node.parentIds, node.complete]);

/** The repository a document sits in, or that it is not known. */
export function repoDocumentScope(
  ids: Readonly<Record<string, string>> | undefined,
  repo: string,
  epoch?: string,
): SourceScopeHierarchyParents {
  return documentScopeParent(
    ids && Object.hasOwn(ids, repoKey(repo)) ? ids[repoKey(repo)] : undefined,
    epoch,
  );
}

/** Drop every scope field, for a gateway that takes none of this. */
function clearRepoScopeCursor(cur: RepoScopeCursor): void {
  for (const field of CURSOR_FIELDS) delete cur[field];
}

/**
 * One `sync()` call's view of the catalogue and its refresh. It reads and
 * writes the scope fields of the cursor the call returns, and collects what
 * the page publishes; `publish` puts that on the page's result.
 */
export class RepoScopes<TCursor extends RepoScopeCursor & SyncCursor> {
  /** The gateway takes hierarchy facts, so documents carry their repository. */
  private readonly stamps: boolean;
  /** This host owns the catalogue and the refresh; a member only stamps. */
  private readonly publishes: boolean;
  /** An older gateway takes facts but no hierarchy: the kind stays closed. */
  private readonly fences: boolean;
  /** The refresh the gateway requires, when it said. */
  private readonly required?: string;
  /**
   * The refresh facts are published under: the required one, or the one last
   * answered when the gateway could not be asked on this page. Facts under a
   * refresh the gateway has since replaced are ignored, and the scan it then
   * asks for sends them again.
   */
  private readonly epoch?: string;
  /** A refresh is waiting for the next cycle to start, to scan over the whole of it. */
  private due = false;
  /** Every listed document is being attributed under the refresh's epoch. */
  private scanning = false;
  private snapshot?: NonNullable<SourceScopeHierarchyUpdate["snapshot"]>;
  private readonly nodes: HierarchyNode[] = [];
  private readonly documents = new Map<string, HierarchyDocument>();
  private controls: Pick<SourceScopeUpdates, "refreshes" | "readiness"> = {};

  constructor(
    private readonly cur: TCursor,
    private readonly opts: SyncOptions | undefined,
  ) {
    const member = opts?.run?.role === "member";
    this.stamps = opts?.scopeHierarchySupported === true;
    this.publishes = this.stamps && !member;
    this.fences = !this.stamps && opts?.scopeFactsSupported === true && !member;
    if (!this.stamps || !isRepoScopeCursor(cur)) clearRepoScopeCursor(cur);
    this.required = this.stamps ? opts?.scopeRefreshEpochs?.folder : undefined;
    this.epoch = this.required ?? cur.scopeReposCut?.epoch;
  }

  /**
   * The page that opens or restarts a refresh, when one is due before any
   * other work. The gateway answers it with the epoch the scan then runs
   * under, so nothing published earlier can be taken for part of this scan.
   */
  handshake(): SyncResult<TCursor> | undefined {
    if (!this.publishes) return undefined;
    const plan = planScopeRefresh(
      this.cur.scopeReposCut,
      this.required,
      true,
      "holder",
      this.opts?.scopeRefreshRequestIds?.folder,
      this.opts?.scopeRefreshActorId,
    );
    if (!plan.epoch) {
      // The gateway names no refresh: it has never opened one for this
      // source, or could not be asked on this page.
      const cut = this.cur.scopeReposCut;
      if (cut) {
        // It named one before, so it is not asked for another, which would
        // discard everything attributed so far. A scan under way goes on
        // under the refresh last named, so no listed document is skipped.
        this.scanning = cut.after === SCANNING && cut.completed !== true;
        return undefined;
      }
      if (this.cur.scopeReposAsked) return undefined;
      this.cur.scopeReposAsked = true;
      this.controls = {
        refreshes: [{ kind: "folder", active: true, requestId: randomUUID() }],
        readiness: [{ kind: "folder", complete: false }],
      };
      return this.publish(syncPage([], this.cur, { hasMore: true }));
    }
    this.cur.scopeReposCut = plan.bookmark;
    if (plan.restart) {
      delete this.cur.scopeReposSnapshot;
      this.controls = {
        refreshes: [
          {
            kind: "folder",
            active: true,
            epoch: plan.epoch,
            restart: true,
            requestId: plan.bookmark?.requestId,
          },
        ],
        readiness: [{ kind: "folder", complete: false }],
      };
      return this.publish(syncPage([], this.cur, { hasMore: plan.continueImmediately }));
    }
    // A scan runs over one whole snapshot cycle, so it starts where a cycle
    // does. Until then the cycle in flight finishes as it was.
    this.scanning = plan.scan && plan.bookmark?.after === SCANNING;
    this.due = plan.scan && !this.scanning;
    return undefined;
  }

  /**
   * Called with the listing a cycle is about to start from. Publishes what
   * changed in the catalogue since the last page that did, and reports whether
   * more remains: the cycle starts once the whole catalogue is out, so no
   * document is listed against a repository the gateway has not been told of.
   * `snapshot` asks for a cycle that lists every document, which a refresh
   * needs; `began` says this page opened one.
   */
  startCycle(rows: readonly RestRepoRow[]): {
    catalogueRemaining: boolean;
    snapshot: boolean;
    began: boolean;
  } {
    if (!this.stamps) return { catalogueRemaining: false, snapshot: false, began: false };
    const { nodes, ids } = repoScopeCatalogue(rows);
    this.cur.scopeReposIds = ids;
    if (!this.publishes) return { catalogueRemaining: false, snapshot: false, began: false };
    const cut = this.cur.scopeReposCut;
    const began = this.due && !!cut;
    if (began) {
      // The whole catalogue goes out again under a new snapshot, and whatever
      // the gateway holds that this one does not name is pruned at its end.
      this.cur.scopeReposSnapshot = randomUUID();
      this.cur.scopeReposNodes = {};
      this.cur.scopeReposCut = { ...cut, after: SCANNING };
      delete this.cur.scopeReposUnlisted;
      this.snapshot = { id: this.cur.scopeReposSnapshot, phase: "begin" };
      this.controls = {
        refreshes: [{ kind: "folder", active: true, epoch: this.epoch }],
        readiness: [{ kind: "folder", complete: false }],
      };
      this.scanning = true;
    }
    const published = { ...(this.cur.scopeReposNodes ?? {}) };
    const current = new Set(nodes.map((node) => node.id));
    const changes: HierarchyNode[] = nodes.filter(
      (node) => published[node.id] !== nodeDigest(node),
    );
    for (const id of Object.keys(published))
      if (!current.has(id))
        changes.push({ id, label: id, parentIds: [], complete: false, deleted: true });
    for (const node of changes.slice(0, MAX_NODES_PER_PAGE)) {
      this.nodes.push(node);
      if (node.deleted) delete published[node.id];
      else published[node.id] = nodeDigest(node);
    }
    this.cur.scopeReposNodes = published;
    return {
      catalogueRemaining: changes.length > MAX_NODES_PER_PAGE,
      snapshot: this.scanning,
      began,
    };
  }

  /** Put a document's repository on it. */
  stamp(document: DocumentInput, repo: string): DocumentInput {
    if (this.stamps)
      document.metadata.scopeHierarchy = [
        repoDocumentScope(this.cur.scopeReposIds, repo, this.epoch),
      ];
    return document;
  }

  /** A snapshot page listed these documents of `repo`. */
  listed(repo: string, externalIds: readonly string[]): void {
    if (!this.publishes) return;
    if (!this.scanning && !this.cur.scopeReposUnlisted?.includes(repoKey(repo))) return;
    const { kind: _kind, ...scope } = repoDocumentScope(this.cur.scopeReposIds, repo, this.epoch);
    for (const externalId of externalIds) this.documents.set(externalId, { externalId, ...scope });
  }

  /** Discovery has listed as much as one page may carry. */
  get full(): boolean {
    return this.documents.size >= WITNESS_YIELD;
  }

  /**
   * A snapshot cycle ended. `unlisted` names the repositories it could not
   * list to the end. The refresh completes all the same: their documents stay
   * unattributed, which a filter treats as withheld, and a later snapshot that
   * lists them attributes them.
   */
  finishSnapshot(unlisted: readonly string[]): void {
    if (!this.publishes) return;
    const missing = new Set(unlisted.map(repoKey));
    if (!this.scanning) {
      const remaining = this.cur.scopeReposUnlisted?.filter((repo) => missing.has(repo));
      if (remaining?.length) this.cur.scopeReposUnlisted = remaining;
      else delete this.cur.scopeReposUnlisted;
      return;
    }
    this.cur.scopeReposCut = { ...this.cur.scopeReposCut!, completed: true };
    if (missing.size) this.cur.scopeReposUnlisted = [...missing].sort();
    else delete this.cur.scopeReposUnlisted;
    if (this.cur.scopeReposSnapshot)
      this.snapshot = { id: this.cur.scopeReposSnapshot, phase: "end" };
    delete this.cur.scopeReposSnapshot;
    this.controls = {
      refreshes: [{ kind: "folder", active: false, epoch: this.epoch }],
      readiness: [{ kind: "folder", complete: true }],
    };
  }

  /** Put this call's catalogue, attributions and refresh state on its page. */
  publish(result: SyncResult<TCursor>): SyncResult<TCursor> {
    if (this.fences)
      return {
        ...result,
        scopeUpdates: {
          refreshes: [{ kind: "folder", active: true }],
          readiness: [{ kind: "folder", complete: false }],
        },
      };
    const hierarchy: SourceScopeHierarchyUpdate | undefined =
      this.nodes.length || this.documents.size || this.snapshot
        ? {
            kind: "folder",
            ...(this.epoch ? { refreshEpoch: this.epoch } : {}),
            ...(this.nodes.length ? { nodes: this.nodes } : {}),
            ...(this.documents.size ? { documents: [...this.documents.values()] } : {}),
            ...(this.snapshot ? { snapshot: this.snapshot } : {}),
          }
        : undefined;
    if (!hierarchy && !this.controls.refreshes) return result;
    return { ...result, scopeUpdates: { ...(hierarchy ? { hierarchy } : {}), ...this.controls } };
  }
}
