// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The cognitive graph walker — the loop / brief / temporal-annotation layer
 * the background agent builds, made traversable through the SAME `boundedWalk`
 * driver as the raw document graph. Given one seed entity it materialises the
 * bounded cognitive neighbourhood around it and projects that into a flat,
 * per-kind-capped {@link CognitiveNeighborhood} — the substrate behind the
 * `entity_context` reap tool.
 *
 * Two invariants keep it safe and honest:
 *  - **Cognitive kinds never leave this module as graph vertices.** The walk's
 *    output is projected to `CognitiveNeighborhood` (a plain grouped record);
 *    the closed `DocumentGraph` / `TrailEvent` wire schema never sees a loop or
 *    temporal-annotation vertex, so every existing render/decoder stays frozen.
 *  - **People are traversal-terminal except as the seed.** A person is a hub;
 *    expanding *out* of every reached person would drag the corpus in. So a
 *    person expands only when it is the seed (depth 0); thereafter it is a leaf.
 *    Person-anchored reads ride the sparse agent-curated join tables (never
 *    `document_people`) and expand the person's merge equivalence class.
 */

import { resolvePersonId } from "../PeopleResolutionService.js";
import {
  getOpenLoop,
  listLoopsForDoc,
  listLoopsForPerson,
  listRelatedLoops,
} from "../../brain/storage/open-loops.js";
import { listLivePersonAnnotationsForPerson } from "../../brain/storage/person-annotations.js";
import {
  listTemporalAnnotationsForDoc,
  listTemporalAnnotationsForLoop,
  listTemporalAnnotationsForPerson,
} from "../../enrichment/temporal-annotations/storage.js";
import { boundedWalk, type Expansion, type WalkNeighbor } from "../graph-engine/bounded-walk.js";
import type { OpenLoopRow } from "../../brain/storage/types.js";
import type { TemporalAnnotation } from "../../enrichment/temporal-annotations/storage.js";
import type {
  CognitiveEdge,
  CognitiveEdgeType,
  CognitiveNeighborhood,
  CognitiveVertex,
  CognitiveVertexKind,
} from "./types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

// ─── Bounds ───────────────────────────────────────────────────────────────

/** Reap is a shallow neighbourhood read, not a deep walk. */
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 3;
/** Per-kind fanout out of a single vertex (a hub loop/person can't flood one kind). */
const PER_KIND_CAP = 12;
/** Global vertex ceiling for the whole reap. */
const MAX_VERTICES = 80;
/** Annotation decorations attached per person vertex. */
const NOTES_PER_PERSON = 5;

function clampDepth(d: number | undefined): number {
  if (d === undefined || !Number.isFinite(d)) return DEFAULT_DEPTH;
  return Math.min(MAX_DEPTH, Math.max(1, Math.trunc(d)));
}

// ─── Vertex keys + builders ─────────────────────────────────────────────────

const key = {
  document: (id: string) => `doc:${id}`,
  person: (id: string) => `person:${id}`,
  loop: (id: string) => `loop:${id}`,
  "temporal-annotation": (id: string) => `temporal-annotation:${id}`,
} satisfies Record<CognitiveVertexKind, (id: string) => string>;

function loopVertex(loop: OpenLoopRow, depth: number): CognitiveVertex {
  return {
    id: key.loop(loop.id),
    kind: "loop",
    depth,
    loopId: loop.id,
    title: loop.title,
    state: loop.state,
    importance: loop.importance,
  };
}

function temporalAnnotationVertex(annotation: TemporalAnnotation, depth: number): CognitiveVertex {
  return {
    id: key["temporal-annotation"](annotation.id),
    kind: "temporal-annotation",
    depth,
    annotationId: annotation.id,
    sentence: annotation.sentence,
    ...(annotation.canonical ? { when: annotation.canonical } : {}),
    ...(annotation.kind ? { annotationKind: annotation.kind } : {}),
  };
}

interface DocMeta {
  id: string;
  title: string | null;
  source_id: string;
}
function loadDoc(db: Db, id: string): DocMeta | null {
  return (
    (db
      .prepare<[string], DocMeta>(`SELECT id, title, source_id FROM documents WHERE id = ?`)
      .get(id) as DocMeta | undefined) ?? null
  );
}
function docVertexFrom(meta: DocMeta, depth: number): CognitiveVertex {
  return {
    id: key.document(meta.id),
    kind: "document",
    depth,
    documentId: meta.id,
    ...(meta.title ? { title: meta.title } : {}),
    sourceId: meta.source_id,
  };
}

interface PersonMeta {
  id: string;
  canonical_name: string;
}
function loadPerson(db: Db, canonicalId: string): PersonMeta | null {
  return (
    (db
      .prepare<
        [string],
        PersonMeta
      >(`SELECT id, canonical_name FROM people WHERE id = ? AND merged_into IS NULL`)
      .get(canonicalId) as PersonMeta | undefined) ?? null
  );
}
function personVertexFrom(meta: PersonMeta, depth: number): CognitiveVertex {
  return {
    id: key.person(meta.id),
    kind: "person",
    depth,
    personId: meta.id,
    name: meta.canonical_name,
  };
}

// ─── Edge identity (undirected de-dup) ─────────────────────────────────────

function edgeKey(edge: CognitiveEdge): string {
  return `${[edge.from, edge.to].sort().join("↔")}|${edge.type}`;
}
function undirected(a: string, b: string, type: CognitiveEdgeType): CognitiveEdge {
  return { from: a, to: b, type };
}

// ─── Expansion ─────────────────────────────────────────────────────────────

/** Slice a reader's result to the per-kind cap, tracking whether it overflowed. */
function capped<T>(rows: T[], cap: number): { rows: T[]; capHit: boolean } {
  return rows.length > cap ? { rows: rows.slice(0, cap), capHit: true } : { rows, capHit: false };
}

/**
 * Fan one cognitive vertex out to its neighbours. Dispatches on kind; each arm
 * rides an existing agent-curated reader (person→loops, loop→docs/people/…),
 * so the traversal reuses the exact liveness + merge-equivalence guarantees the
 * inline surfaces already have. `seedIsPerson` lets the seed person expand while
 * every *other* person stays terminal.
 */
function expandCognitive(
  db: Db,
  vertex: CognitiveVertex,
  now: number,
): Expansion<CognitiveVertex, CognitiveEdge> {
  const nextDepth = vertex.depth + 1;
  const neighbors: WalkNeighbor<CognitiveVertex, CognitiveEdge>[] = [];
  let capHits = 0;

  const addLoop = (loop: OpenLoopRow, edgeType: CognitiveEdgeType): void => {
    const v = loopVertex(loop, nextDepth);
    neighbors.push({ vertex: v, edge: undirected(vertex.id, v.id, edgeType), terminal: false });
  };
  const addTemporalAnnotation = (
    annotation: TemporalAnnotation,
    edgeType: CognitiveEdgeType,
  ): void => {
    const v = temporalAnnotationVertex(annotation, nextDepth);
    neighbors.push({ vertex: v, edge: undirected(vertex.id, v.id, edgeType), terminal: false });
  };
  const addDoc = (id: string, edgeType: CognitiveEdgeType): void => {
    const meta = loadDoc(db, id);
    if (!meta) return;
    const v = docVertexFrom(meta, nextDepth);
    neighbors.push({ vertex: v, edge: undirected(vertex.id, v.id, edgeType), terminal: false });
  };
  const addPerson = (canonicalId: string, edgeType: CognitiveEdgeType): void => {
    const meta = loadPerson(db, resolvePersonId(db, canonicalId));
    if (!meta) return;
    const v = personVertexFrom(meta, nextDepth);
    // People are leaves in the walk (hubs); reached, linked, never expanded.
    neighbors.push({ vertex: v, edge: undirected(vertex.id, v.id, edgeType), terminal: true });
  };

  switch (vertex.kind) {
    case "person": {
      const loops = capped(listLoopsForPerson(db, vertex.personId), PER_KIND_CAP);
      if (loops.capHit) capHits++;
      for (const l of loops.rows) addLoop(l, "involves");
      const temporalAnnotations = capped(
        listTemporalAnnotationsForPerson(db, vertex.personId),
        PER_KIND_CAP,
      );
      if (temporalAnnotations.capHit) capHits++;
      for (const annotation of temporalAnnotations.rows) {
        addTemporalAnnotation(annotation, "dated-in");
      }
      break;
    }
    case "loop": {
      const loop = getOpenLoop(db, vertex.loopId);
      if (loop) {
        const docs = capped(loop.docs, PER_KIND_CAP);
        if (docs.capHit) capHits++;
        for (const d of docs.rows) addDoc(d, "grounds-in");
        const people = capped([...loop.actors, ...loop.involved], PER_KIND_CAP);
        if (people.capHit) capHits++;
        for (const p of people.rows) addPerson(p, "involves");
      }
      const related = capped(listRelatedLoops(db, vertex.loopId, now), PER_KIND_CAP);
      if (related.capHit) capHits++;
      for (const l of related.rows) addLoop(l, "related-to");
      const temporalAnnotations = capped(
        listTemporalAnnotationsForLoop(db, vertex.loopId),
        PER_KIND_CAP,
      );
      if (temporalAnnotations.capHit) capHits++;
      for (const annotation of temporalAnnotations.rows) {
        addTemporalAnnotation(annotation, "dated-in");
      }
      break;
    }
    case "document": {
      const loops = capped(listLoopsForDoc(db, vertex.documentId), PER_KIND_CAP);
      if (loops.capHit) capHits++;
      for (const l of loops.rows) addLoop(l, "grounds-in");
      const temporalAnnotations = capped(
        listTemporalAnnotationsForDoc(db, vertex.documentId, PER_KIND_CAP + 1),
        PER_KIND_CAP,
      );
      if (temporalAnnotations.capHit) capHits++;
      for (const annotation of temporalAnnotations.rows) {
        addTemporalAnnotation(annotation, "evidenced-by");
      }
      break;
    }
    case "temporal-annotation": {
      // The annotation's docs/loops live in the temporal annotation joins
      // tables (the entry vertex was built from a live reader, so it is live).
      const docIds = db
        .prepare<[string], { document_id: string }>(
          `SELECT document_id
             FROM temporal_annotation_documents
            WHERE annotation_id = ?`,
        )
        .all(vertex.annotationId)
        .map((r) => r.document_id);
      const docs = capped(docIds, PER_KIND_CAP);
      if (docs.capHit) capHits++;
      for (const d of docs.rows) addDoc(d, "evidenced-by");
      const loopIds = db
        .prepare<[string], { loop_id: string }>(
          `SELECT loop_id FROM temporal_annotation_loops WHERE annotation_id = ?`,
        )
        .all(vertex.annotationId)
        .map((r) => r.loop_id);
      for (const lid of loopIds.slice(0, PER_KIND_CAP)) {
        const loop = getOpenLoop(db, lid);
        // Liveness: an annotation's loop backlink survives the loop resolving
        // (done/dismissed) — the FK only cascades on delete — so filter to the
        // active states, matching every other loop reader in this service.
        if (loop && (loop.state === "open" || loop.state === "snoozed")) addLoop(loop, "dated-in");
      }
      break;
    }
  }

  return { capHits, neighbors };
}

// ─── Seed resolution + reap ────────────────────────────────────────────────

export interface ReapSeed {
  kind: "document" | "person" | "loop";
  id: string;
}
export interface ReapOptions {
  depth?: number;
}

function resolveSeedVertex(db: Db, seed: ReapSeed): CognitiveVertex | null {
  switch (seed.kind) {
    case "person": {
      const meta = loadPerson(db, resolvePersonId(db, seed.id));
      return meta ? personVertexFrom(meta, 0) : null;
    }
    case "loop": {
      const loop = getOpenLoop(db, seed.id);
      return loop ? loopVertex(loop, 0) : null;
    }
    case "document": {
      const meta = loadDoc(db, seed.id);
      return meta ? docVertexFrom(meta, 0) : null;
    }
  }
}

/**
 * Reap the cognitive neighbourhood around one seed entity. Resolves the seed,
 * runs the shallow bounded walk, decorates every reached person with their live
 * agent-authored claims, and projects the result to a flat per-kind grouping.
 * A missing / non-cognitive seed yields an empty neighbourhood with `seed:null`
 * (never throws) so a caller holding a stale id degrades gracefully.
 */
export function reapEntityContext(
  db: Db,
  seed: ReapSeed,
  opts: ReapOptions = {},
): CognitiveNeighborhood {
  const seedVertex = resolveSeedVertex(db, seed);
  if (!seedVertex) return emptyNeighborhood();

  const now = Date.now();
  const walk = boundedWalk<CognitiveVertex, CognitiveEdge>({
    seeds: [seedVertex],
    // The seed expands whatever it is; thereafter people are terminal (hubs).
    canExpand: (v) => v.depth === 0 || v.kind !== "person",
    expand: (v) => expandCognitive(db, v, now),
    maxDepth: clampDepth(opts.depth),
    maxVertices: MAX_VERTICES,
    edgeKey,
  });

  return projectNeighborhood(db, seedVertex, walk.vertices, walk.truncated);
}

function projectNeighborhood(
  db: Db,
  seedVertex: CognitiveVertex,
  vertices: Map<string, CognitiveVertex>,
  truncated: boolean,
): CognitiveNeighborhood {
  const out = emptyNeighborhood();
  out.seed = { kind: seedVertex.kind, id: seedIdOf(seedVertex), label: labelOf(seedVertex) };
  out.truncated = truncated;

  for (const v of vertices.values()) {
    if (v.id === seedVertex.id) continue; // the seed isn't its own neighbour
    switch (v.kind) {
      case "loop":
        out.loops.push({
          loopId: v.loopId,
          title: v.title,
          state: v.state,
          ...(v.importance !== undefined ? { importance: v.importance } : {}),
        });
        break;
      case "document":
        out.documents.push({
          documentId: v.documentId,
          ...(v.title ? { title: v.title } : {}),
          ...(v.sourceId ? { sourceId: v.sourceId } : {}),
        });
        break;
      case "person": {
        const notes = listLivePersonAnnotationsForPerson(db, v.personId, NOTES_PER_PERSON).map(
          (a) => a.claimText,
        );
        out.people.push({
          personId: v.personId,
          name: v.name,
          ...(notes.length > 0 ? { notes } : {}),
        });
        break;
      }
      case "temporal-annotation":
        out.temporalAnnotations.push({
          annotationId: v.annotationId,
          sentence: v.sentence,
          ...(v.when ? { when: v.when } : {}),
          ...(v.annotationKind ? { kind: v.annotationKind } : {}),
        });
        break;
    }
  }

  out.counts = {
    loops: out.loops.length,
    documents: out.documents.length,
    people: out.people.length,
    temporalAnnotations: out.temporalAnnotations.length,
  };
  return out;
}

function emptyNeighborhood(): CognitiveNeighborhood {
  return {
    seed: null,
    loops: [],
    documents: [],
    people: [],
    temporalAnnotations: [],
    truncated: false,
    counts: { loops: 0, documents: 0, people: 0, temporalAnnotations: 0 },
  };
}

function seedIdOf(v: CognitiveVertex): string {
  switch (v.kind) {
    case "document":
      return v.documentId;
    case "person":
      return v.personId;
    case "loop":
      return v.loopId;
    case "temporal-annotation":
      return v.annotationId;
  }
}
function labelOf(v: CognitiveVertex): string {
  switch (v.kind) {
    case "document":
      return v.title ?? v.documentId;
    case "person":
      return v.name;
    case "loop":
      return v.title;
    case "temporal-annotation":
      return v.sentence;
  }
}
