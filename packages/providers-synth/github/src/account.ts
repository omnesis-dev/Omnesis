// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The repositories of the invented GitHub account, as its listing names them
 * right now.
 *
 * It starts as the repositories of the active universe's fixture and is held
 * in memory, so a test can rename a repository, hand it to another owner or
 * take it out of the listing between two syncs and watch the next ordinary
 * sync carry the change. Nothing here touches a document: a document is filed
 * under the id its repository had in the fixture, and that id never changes.
 */

import { repositoryList } from "@omnesis/provider-github";
import type { FilterListItem } from "@omnesis/types";
import type { RepoRow } from "./fixtures.js";

export class GithubAccount {
  private rows: RepoRow[];
  private failing = false;
  /** How many times the listing has been read to the end. */
  listings = 0;

  constructor(rows: readonly RepoRow[]) {
    this.rows = rows.map((row) => ({ ...row, ...(row.owner ? { owner: { ...row.owner } } : {}) }));
  }

  /** Give the repository a new name under the owner that holds it. */
  rename(id: number, name: string): void {
    const row = this.row(id);
    row.full_name = `${row.full_name.split("/")[0]}/${name}`;
  }

  /** Hand the repository to another owner; GitHub keeps its id and its name. */
  transfer(id: number, owner: { id: number; login: string }): void {
    const row = this.row(id);
    row.owner = { ...owner };
    row.full_name = `${owner.login}/${row.full_name.split("/")[1]}`;
  }

  /** Take the repository out of the listing, as a deletion or a revoked grant does. */
  remove(id: number): void {
    this.row(id);
    this.rows = this.rows.filter((row) => row.id !== id);
  }

  /** Make every listing fail until switched back, as an unreachable account would. */
  failListings(failing: boolean): void {
    this.failing = failing;
  }

  /** The owners and repositories of the account, built as the live source builds them. */
  list(): FilterListItem[] {
    if (this.failing) throw new Error("The GitHub account could not be listed");
    this.listings++;
    return repositoryList(this.rows);
  }

  private row(id: number): RepoRow {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`No repository ${id} in the GitHub account`);
    return row;
  }
}

const accounts = new Map<string, GithubAccount>();

export function registerAccount(sourceId: string, account: GithubAccount): void {
  accounts.set(sourceId, account);
}

export function unregisterAccount(sourceId: string): void {
  accounts.delete(sourceId);
}

/** The live account of a fully qualified `github:<account>` or `github-commits:<account>` source. */
export function getGithubAccount(sourceId: string): GithubAccount | undefined {
  return accounts.get(sourceId);
}
