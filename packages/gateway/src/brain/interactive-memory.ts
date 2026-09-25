// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Interactive memory shares the evidence firewall without starting background cognition. */
import { buildAnnotationTools, type AnnotationToolDeps } from "./steward/tools.js";
import { subscribeAnnotationInvalidator } from "./annotation-invalidator.js";
import { subscribePersonAnnotationInvalidator } from "./person-annotation-invalidator.js";
import { systemClock } from "./storage/types.js";
import type { ResolvedBrainSettings } from "./config.js";
import type { EventBus } from "../events.js";
import type { WriteGate } from "../write-gate.js";
import type { ToolHandle } from "@omnesis/agent";

type MemoryDeps = Pick<
  AnnotationToolDeps,
  "db" | "writeGate" | "log" | "getEntailmentVerifier" | "validateAnnotationEvidence"
> & {
  getSettings: () => Pick<
    ResolvedBrainSettings,
    "annotationConfidenceCeiling" | "annotationBasisCeilings" | "annotationConfidenceFloor"
  >;
  clock?: () => number;
};

/** The background annotations toggle controls automation, not user-directed memory. */
export function createInteractiveMemoryProfile(deps: MemoryDeps): {
  buildOwnTools(runId: string): ToolHandle[];
} {
  return {
    buildOwnTools(runId) {
      const settings = deps.getSettings();
      return buildAnnotationTools({
        db: deps.db,
        writeGate: deps.writeGate,
        log: deps.log,
        clock: deps.clock ?? systemClock,
        runId,
        annotationConfidenceCeiling: settings.annotationConfidenceCeiling,
        annotationBasisCeilings: settings.annotationBasisCeilings,
        annotationConfidenceFloor: settings.annotationConfidenceFloor,
        ...(deps.validateAnnotationEvidence
          ? { validateAnnotationEvidence: deps.validateAnnotationEvidence }
          : {}),
        ...(deps.getEntailmentVerifier
          ? { getEntailmentVerifier: deps.getEntailmentVerifier }
          : {}),
      });
    },
  };
}

/** Evidence lifecycle maintenance must survive disabling background cognition or memory writes. */
export function subscribeMemoryInvalidators(deps: {
  db: AnnotationToolDeps["db"];
  writeGate: Pick<WriteGate, "invalidateAnnotationsForDoc" | "invalidatePersonAnnotationsForDoc">;
  eventBus: Pick<EventBus, "on">;
  log: AnnotationToolDeps["log"];
  clock?: () => number;
}): () => void {
  const shared = {
    db: deps.db,
    eventBus: deps.eventBus,
    clock: deps.clock ?? systemClock,
    isEnabled: () => true,
  };
  const unsubscribers = [
    subscribeAnnotationInvalidator({
      ...shared,
      invalidate: (docId, now) => deps.writeGate.invalidateAnnotationsForDoc(docId, now),
      log: deps.log.child("annotations"),
    }),
    subscribePersonAnnotationInvalidator({
      ...shared,
      invalidate: (docId, now) => deps.writeGate.invalidatePersonAnnotationsForDoc(docId, now),
      log: deps.log.child("person-annotations"),
    }),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
