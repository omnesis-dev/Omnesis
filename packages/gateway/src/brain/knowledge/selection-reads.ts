// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  listOrganizationAdmissions,
  type OrganizationAdmission,
  type OrganizationAdmissionOptions,
} from "./organization.js";
import {
  newSubjectCohortTally,
  selectOrganizationCohort,
  type OrganizationCohortOptions,
  type OrganizationCohortSelection,
  type SubjectCohortTally,
} from "./organization-cohorts.js";
import {
  listDueKnowledgeReviews,
  type DueKnowledgeReview,
  type DueKnowledgeReviewOptions,
} from "./review-selection.js";
import { hasKnowledgeWorkFromExcludedSources, listStaleKnowledgeWork } from "./work.js";
import { readKnowledgeArcs, type KnowledgeArcRead } from "./engine-graph.js";
import type Database from "better-sqlite3";

/**
 * Cohort selection options as plain data: the passed-over keys travel as
 * arrays and the subject tally comes back in the result.
 */
export interface OrganizationCohortReadOptions extends Omit<
  OrganizationCohortOptions,
  "skipSubjects" | "skipFingerprints" | "subjectTally"
> {
  skipSubjects?: readonly string[];
  skipFingerprints?: readonly string[];
}

export interface OrganizationCohortRead {
  selection: OrganizationCohortSelection | null;
  tally: SubjectCohortTally;
}

/**
 * The knowledge engine's heaviest reads: each scans the knowledge ledgers to
 * choose what the next tick works on, and returns only the choice. The gateway
 * runs them on a read worker so a tick never stalls the main event loop. Each
 * read takes its own snapshot after the tick's previous write has committed,
 * and the writer refuses an action whose node or source revision has moved, so
 * these reads are exactly as current as reads on the main handle.
 */
export interface KnowledgeSelectionReads {
  knowledgeOrganizationAdmissions(
    options: OrganizationAdmissionOptions,
  ): Promise<OrganizationAdmission[]>;
  knowledgeOrganizationCohort(
    options: OrganizationCohortReadOptions,
  ): Promise<OrganizationCohortRead>;
  knowledgeDueReviews(options: DueKnowledgeReviewOptions): Promise<DueKnowledgeReview[]>;
  /** Pending work the planner refreshes before planning; see `listStaleKnowledgeWork`. */
  knowledgeStaleWork(limit: number): Promise<string[]>;
  /** Whether pending source work belongs to a source excluded from the Brain. */
  knowledgeHasExcludedWork(excludedSources: readonly string[]): Promise<boolean>;
  /** The planner's graph read for a planning pass; see `readKnowledgeArcs`. */
  knowledgeArcs(inputs: readonly string[], bound: number): Promise<KnowledgeArcRead>;
}

export function readOrganizationCohort(
  db: Database.Database,
  options: OrganizationCohortReadOptions,
): OrganizationCohortRead {
  const { skipSubjects, skipFingerprints, ...rest } = options;
  const tally = newSubjectCohortTally();
  const selection = selectOrganizationCohort(db, {
    ...rest,
    ...(skipSubjects ? { skipSubjects: new Set(skipSubjects) } : {}),
    ...(skipFingerprints ? { skipFingerprints: new Set(skipFingerprints) } : {}),
    subjectTally: tally,
  });
  return { selection, tally };
}

/** The same reads on the caller's own handle, for runtimes without a read worker. */
export function directKnowledgeSelectionReads(db: Database.Database): KnowledgeSelectionReads {
  return {
    knowledgeOrganizationAdmissions: (options) =>
      Promise.resolve(listOrganizationAdmissions(db, options)),
    knowledgeOrganizationCohort: (options) => Promise.resolve(readOrganizationCohort(db, options)),
    knowledgeDueReviews: (options) => Promise.resolve(listDueKnowledgeReviews(db, options)),
    knowledgeStaleWork: (limit) => Promise.resolve(listStaleKnowledgeWork(db, limit)),
    knowledgeHasExcludedWork: (excludedSources) =>
      Promise.resolve(hasKnowledgeWorkFromExcludedSources(db, excludedSources)),
    knowledgeArcs: (inputs, bound) => Promise.resolve(readKnowledgeArcs(db, inputs, bound)),
  };
}

/** The reads a knowledge engine was given, or its own handle's when it was given none. */
export function knowledgeSelectionReads(deps: {
  db: Database.Database;
  selectionReads?: KnowledgeSelectionReads;
}): KnowledgeSelectionReads {
  return deps.selectionReads ?? directKnowledgeSelectionReads(deps.db);
}
