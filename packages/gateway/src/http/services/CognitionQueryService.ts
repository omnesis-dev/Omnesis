// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeCalibrationReport } from "../../brain/calibration.js";
import { cognitionMechanismLabel } from "../../brain/cognition/workflows.js";
import { getDocAnnotation } from "../../brain/storage/annotations.js";
import { listLiveDependentsForAnnotation } from "../../brain/storage/consumption-edges.js";
import { getPersonAnnotation } from "../../brain/storage/person-annotations.js";
import { listCognitionSpend } from "../../brain/storage/spend.js";
import type { CalibrationFamily } from "../../brain/calibration.js";
import type { ConsumptionPriorStore } from "../../brain/storage/consumption-edges.js";
import type Database from "better-sqlite3";

export class CognitionQueryService {
  constructor(private readonly db: Database.Database) {}

  listSpend(days: number) {
    return listCognitionSpend(this.db, { days }).map((row) => ({
      ...row,
      mechanismLabel: cognitionMechanismLabel(row.mechanism),
    }));
  }

  calibration(options: { family?: CalibrationFamily; sinceDays?: number; now: number }) {
    return computeCalibrationReport(this.db, options);
  }

  listAnnotationDependents(
    store: ConsumptionPriorStore,
    annotationId: string,
    options: Parameters<typeof listLiveDependentsForAnnotation>[3],
  ) {
    const annotation =
      store === "doc"
        ? getDocAnnotation(this.db, annotationId)
        : getPersonAnnotation(this.db, annotationId);
    if (!annotation) return null;
    return listLiveDependentsForAnnotation(this.db, store, annotationId, options);
  }
}
