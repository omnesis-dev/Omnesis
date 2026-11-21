// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which repository a GitHub document sits in, and the list of the
 * repositories and owners an account holds.
 *
 * Both are spelled with GitHub's own numeric ids, never with names. A renamed
 * repository or owner keeps its id, and so does a repository transferred to
 * another owner, so a document filed under a repository's id stays filed
 * there whatever the repository is called and whoever holds it.
 *
 * A document carries the id of its repository and nothing above it. Which
 * owner holds a repository is said once, in the list: owners are its roots
 * and each repository sits beneath the owner that holds it, so a fork sits
 * beneath whoever holds the fork, and a transfer changes one entry of the
 * list and no document.
 *
 * Everything here comes from the listing of the account's repositories that a
 * sync reads anyway. Nothing is asked of GitHub per repository or per
 * document.
 */

import { resolveRepos } from "./repo-selection.js";
import type { FilterListProducer } from "@omnesis/source-sdk";
import type { DocumentInput, FilterListItem } from "@omnesis/types";
import type { GithubClient } from "./client.js";
import type { RestRepoRow } from "./types.js";

/** Profile path of the field holding the id of a document's repository. */
export const REPOSITORY_FIELD = "extra.repositoryIds";

/**
 * How long a listing read by a sync also serves the list published right
 * after it. The list is produced once the first page of a sync has committed,
 * which for a sync that begins by listing the account is moments later.
 */
const LISTING_REUSE_MS = 60 * 1000;

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * The list id of a repository: GitHub's id for it, which is also what a
 * document carries.
 */
export const repositoryItemId = (id: number): string => String(id);

/**
 * The list id of an owner. Repositories and owners are numbered separately on
 * GitHub, so the same number can name one of each; the prefix keeps the two
 * apart in one list, and no repository id can contain it.
 */
export const ownerItemId = (id: number): string => `owner:${id}`;

/**
 * File a document under its repository. A repository GitHub's listing gave no
 * id for leaves the document as it is: where it sits is then not known, which
 * is different from sitting nowhere.
 */
export function inRepository(doc: DocumentInput, repositoryId: number | undefined): DocumentInput {
  if (!isId(repositoryId)) return doc;
  return {
    ...doc,
    metadata: {
      ...doc.metadata,
      extra: { ...doc.metadata.extra, repositoryIds: [repositoryItemId(repositoryId)] },
    },
  };
}

/**
 * The owners and repositories of a listing: owners as roots, each repository
 * beneath the owner that holds it.
 *
 * A repository appears only when the listing gives an id for it and for its
 * owner. Without either it cannot be placed in the tree, and a guess would
 * file its documents under the wrong owner.
 */
export function repositoryList(rows: readonly RestRepoRow[]): FilterListItem[] {
  const owners = new Map<string, FilterListItem>();
  const repositories = new Map<string, FilterListItem>();
  for (const row of rows) {
    if (!isId(row.id) || !isId(row.owner?.id)) continue;
    const ownerId = ownerItemId(row.owner.id);
    if (!owners.has(ownerId)) {
      // The owner's login is the first half of the name of every repository it holds.
      const login = row.owner.login || row.full_name.split("/")[0];
      owners.set(ownerId, { id: ownerId, label: login });
    }
    // A listing read while repositories are being created can name one twice.
    const id = repositoryItemId(row.id);
    if (!repositories.has(id))
      repositories.set(id, { id, label: row.full_name, parentId: ownerId });
  }
  return [...owners.values(), ...repositories.values()];
}

/** Repository names are case-insensitive on GitHub. */
const nameKey = (fullName: string): string => fullName.toLowerCase();

/**
 * The repositories one source indexes, as GitHub last listed them.
 *
 * A sync reads the listing when its cycle starts. The same listing then names
 * the id each document is filed under and fills the published list, so a
 * cycle costs one listing however many documents it writes.
 */
export class Repositories {
  private listing: { rows: RestRepoRow[]; ids: Map<string, number>; readAt: number } | undefined;

  constructor(
    private readonly client: GithubClient,
    private readonly sourceConfig: Record<string, unknown> | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** Read the listing from GitHub and remember it. */
  async list(): Promise<RestRepoRow[]> {
    const rows = await resolveRepos(this.client, this.sourceConfig);
    const ids = new Map<string, number>();
    for (const row of rows) {
      if (isId(row.id)) ids.set(nameKey(row.full_name), row.id);
    }
    this.listing = { rows, ids, readAt: this.now() };
    return rows;
  }

  /**
   * GitHub's id for the repository called `fullName`, or `undefined` when the
   * listing does not name it or gives it no id.
   *
   * Answers from the listing the cycle read. A cycle resumed in a process
   * that has not listed yet reads the listing once.
   */
  async idOf(fullName: string): Promise<number | undefined> {
    if (this.listing === undefined) await this.list();
    return this.listing?.ids.get(nameKey(fullName));
  }

  /**
   * Lists the owners and repositories of the account. Throws when the
   * listing cannot be read, so a list is never published in part.
   */
  readonly filterList: FilterListProducer = async () => {
    const recent =
      this.listing !== undefined && this.now() - this.listing.readAt <= LISTING_REUSE_MS;
    return repositoryList(recent ? this.listing!.rows : await this.list());
  };
}
