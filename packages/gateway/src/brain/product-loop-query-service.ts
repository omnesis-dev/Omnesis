// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mutableListRevision } from "../data/list-revisions.js";
import { fetchSelfPersonId } from "../domain/InteractionScoreService.js";
import { displayPersonRefs } from "./person-refs.js";
import {
  getActiveLoopTitle,
  getOpenLoop,
  listOpenLoopLedger,
  listOpenLoops,
  type ListOpenLoopsOptions,
} from "./storage/open-loops.js";
import type { OpenLoopRow } from "./storage/types.js";
import type Database from "better-sqlite3";

export interface ProductLoopView {
  row: OpenLoopRow;
  actors: Array<{ id: string; name: string | null; isSelf: boolean }>;
  involved: Array<{ id: string; name: string | null }>;
  blockedBy: Array<{ id: string; title: string }>;
}

/** Read-side boundary for the product Radar list and detail routes. */
export class ProductLoopQueryService {
  constructor(private readonly db: Database.Database) {}

  paginationRevision(): number {
    return mutableListRevision(this.db, "product-loops");
  }

  list(options: ListOpenLoopsOptions = {}): ProductLoopView[] {
    const selfId = fetchSelfPersonId(this.db);
    return listOpenLoops(this.db, options).map((row) => this.enrich(row, selfId));
  }

  get(id: string): ProductLoopView | null {
    const row = getOpenLoop(this.db, id);
    return row ? this.enrich(row, fetchSelfPersonId(this.db)) : null;
  }

  listLedger(id: string, options?: Parameters<typeof listOpenLoopLedger>[2]) {
    return listOpenLoopLedger(this.db, id, options);
  }

  private enrich(row: OpenLoopRow, selfId: string | null): ProductLoopView {
    const actors = displayPersonRefs(this.db, row.actors).map((ref) => ({
      ...ref,
      isSelf: selfId !== null && ref.id === selfId,
    }));
    const blockedBy: ProductLoopView["blockedBy"] = [];
    for (const id of row.blockedBy) {
      const title = getActiveLoopTitle(this.db, id);
      if (title !== null) blockedBy.push({ id, title });
    }
    return {
      row,
      actors,
      involved: displayPersonRefs(this.db, row.involved),
      blockedBy,
    };
  }
}
