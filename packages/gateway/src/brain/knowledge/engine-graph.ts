// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { knowledgeSourceRevisionSql } from "./source-revision.js";
import {
  MaintenancePlanLimitError,
  type MaintenanceAdjacency,
  type MaintenanceArc,
} from "./planner.js";
import type Database from "better-sqlite3";

/** Inputs read per bulk adjacency statement. */
const ADJACENCY_CHUNK = 500;

/**
 * The three arc kinds one input can have: claim dependencies on it, loops it
 * blocks, and nodes its current source revision was discovered for. Each row
 * of `inputs` names an input with the key each branch matches it by; a key
 * that cannot match (the empty string) leaves that branch empty for it. The
 * discovery branch reads a document only when a discovery target names it:
 * reaching `content_hash` past a document's content walks the content's
 * overflow pages, which a source without discovery targets never needs.
 */
function arcsSql(inputs: string): string {
  return `
    SELECT i.input AS input,k.node_id AS dependent FROM ${inputs} i
      CROSS JOIN knowledge_dependencies k
      WHERE k.target_kind=i.kind AND k.target_id=i.target AND k.relation!='context'
    UNION SELECT i.input,o.node_id FROM ${inputs} i
      CROSS JOIN knowledge_operational_arcs o WHERE o.input_id=i.operational
    UNION SELECT i.input,t.node_id FROM ${inputs} i
      CROSS JOIN knowledge_discovery_targets t
      CROSS JOIN documents d ON d.id=t.source_id AND ${knowledgeSourceRevisionSql()}=t.source_revision
      WHERE t.source_id=i.source`;
}

/** The keys `arcsSql` matches one input by: kind, target, operational and source. */
function inputKeys(input: string): [string, string, string, string, string] {
  const source = input.startsWith("source:");
  const id = source ? input.slice(7) : input;
  return [input, source ? "source" : "node", id, source ? "" : id, source ? id : ""];
}

/**
 * Each input with its dependents as `KnowledgeGraph.arcs` reads them, or null
 * where its fanout exceeds the bound. Plain data, so a read worker can return it.
 */
export type KnowledgeArcRead = Array<[input: string, dependents: string[] | null]>;

/**
 * The dependents of many inputs in a few bulk statements. On a large pending
 * backlog this is the planner's heaviest read; the engine runs it on a read
 * worker and plans from the result.
 */
export function readKnowledgeArcs(
  db: Database.Database,
  inputs: readonly string[],
  bound: number,
): KnowledgeArcRead {
  const wanted = [...new Set(inputs)];
  if (!wanted.length) return [];
  const statement = db.prepare<[string, number], MaintenanceArc>(
    `WITH i(input,kind,target,operational,source) AS (
       SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),
         json_extract(value,'$[3]'),json_extract(value,'$[4]') FROM json_each(?))
     SELECT input,dependent FROM (
       SELECT input,dependent,ROW_NUMBER() OVER (PARTITION BY input ORDER BY dependent) AS rank
       FROM (${arcsSql("i")}) WHERE dependent>'')
     WHERE rank<=? ORDER BY input,dependent`,
  );
  const result: KnowledgeArcRead = [];
  for (let at = 0; at < wanted.length; at += ADJACENCY_CHUNK) {
    const chunk = wanted.slice(at, at + ADJACENCY_CHUNK);
    const dependents = new Map(chunk.map((input) => [input, [] as string[]]));
    for (const arc of statement.all(JSON.stringify(chunk.map(inputKeys)), bound + 1))
      dependents.get(arc.input)!.push(arc.dependent);
    for (const [input, list] of dependents) result.push([input, list.length > bound ? null : list]);
  }
  return result;
}

/** Indexed adjacency, never a materialized copy of the whole brain graph. */
export class KnowledgeGraph {
  private pageStatement?: Database.Statement<
    [string, string, string, string, string, string, number],
    { dependent: string }
  >;
  constructor(
    private readonly db: Database.Database,
    private readonly bound: () => number,
  ) {}
  page(input: string, after: string, limit: number): MaintenanceArc[] {
    this.pageStatement ??= this.db.prepare(
      `WITH i(input,kind,target,operational,source) AS (SELECT ?,?,?,?,?)
       SELECT dependent FROM (${arcsSql("i")}) WHERE dependent>? ORDER BY dependent LIMIT ?`,
    );
    return this.pageStatement
      .all(...inputKeys(input), after, limit)
      .map((row) => ({ input, dependent: row.dependent }));
  }
  arcs(input: string): MaintenanceArc[] {
    const max = this.bound();
    const rows = this.page(input, "", max + 1);
    if (rows.length > max) throw new MaintenancePlanLimitError("region");
    return rows;
  }
  /**
   * The dependents of each input as `arcs` reads them, for one synchronous
   * planning pass: inputs in `read` come from it, any other is read here on
   * first use. Each result is kept for the pass, and an input whose fanout
   * exceeds the bound throws whenever it is requested, as `arcs` does.
   */
  adjacency(read: KnowledgeArcRead = []): MaintenanceAdjacency {
    const known = new Map(read);
    return (input) => {
      let dependents = known.get(input);
      if (dependents === undefined) {
        try {
          dependents = this.arcs(input).map((arc) => arc.dependent);
        } catch (error) {
          if (!(error instanceof MaintenancePlanLimitError)) throw error;
          dependents = null;
        }
        known.set(input, dependents);
      }
      if (dependents === null) throw new MaintenancePlanLimitError("region");
      return dependents;
    };
  }
}
