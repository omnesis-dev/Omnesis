// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { expect, test } from "vitest";
import { createOpenLoop, getOpenLoop } from "../../../gateway/src/brain/storage/open-loops.js";
import { captureOutcomeWriteFence } from "../../../gateway/src/brain/storage/outcome-write-fence.js";
import { outcomeProposal } from "../../../gateway/src/brain/record-check/outcome-context.js";
import { convertKnowledgeOwner } from "../../../gateway/src/brain/knowledge/owner-adapters.js";
import {
  makeOutcomeAssessment,
  persistOutcomeAssessment,
} from "../../../gateway/src/brain/knowledge/outcome-assessment.js";
import { enqueueKnowledgeWork } from "../../../gateway/src/brain/knowledge/work.js";
import {
  BrainBench,
  compressCognitionCadences,
  email,
  preserveCurrentOwner,
  sourceInterpretations,
  waitFor,
} from "./brain-bench/index.js";

compressCognitionCadences();

test("old-policy outcomes are reviewed without rewriting, and unchanged repair reuses the current assessment", async () => {
  const description = "Calibrate the tide sensor before the survey.";
  const ownerId = "legacy-calibration";
  const bench = await BrainBench.start({
    experimental: true,
    brain: {
      knowledge: { soonDelay: "1s", routineDelay: "1s", maxSeeds: 1, maxFrontierNodes: 1 },
      annotations: { recordCheck: "enforce" },
    },
    entailment: () => "entailment",
    decision: {
      policy: (request) =>
        Object.fromEntries(
          Object.keys(request.questions).map((id) => [id, { type: "score" as const, score: 2.5 }]),
        ),
    },
    behaviors: {
      dynamic: sourceInterpretations({ sources: [], maintainNode: preserveCurrentOwner }),
    },
  });
  try {
    const [sourceId] = await bench.pushAndSettle([
      email({
        externalId: "calibration-survey",
        title: "Survey preparation",
        content: description,
      }),
    ]);
    await bench.drainUntilQuiet();
    bench.withWriteHandle((db) =>
      db.transaction(() => {
        const now = Date.now();
        createOpenLoop(
          db,
          {
            id: ownerId,
            title: "Sensor calibration",
            description,
            createdByRun: "legacy-seed",
            docs: [sourceId!],
            importance: 0.4,
            confidence: 0.8,
          },
          now,
        );
        convertKnowledgeOwner(db, "loop", ownerId, now);
        const fence = captureOutcomeWriteFence(db, ownerId, [sourceId!]);
        persistOutcomeAssessment(
          db,
          ownerId,
          makeOutcomeAssessment(
            "obsolete-policy",
            outcomeProposal(getOpenLoop(db, ownerId)!),
            fence.sources,
            "legacy-decision",
            null,
          ),
          fence.sources,
          now,
        );
      })(),
    );
    await waitFor(
      "current outcome policy assessment",
      () =>
        bench.sql
          .prepare(
            "SELECT 1 FROM knowledge_outcome_assessments WHERE owner_id=? AND policy!='obsolete-policy' AND status='pass'",
          )
          .get(ownerId)
          ? true
          : null,
      60_000,
    );
    await bench.drainUntilQuiet();
    const count = () =>
      (
        bench.sql
          .prepare(
            "SELECT COUNT(*) AS n FROM cognition_decisions WHERE record_id=? AND purpose='record-check'",
          )
          .get(ownerId) as { n: number }
      ).n;
    expect(count()).toBe(1);
    expect(
      (
        bench.sql.prepare("SELECT description FROM open_loops WHERE id=?").get(ownerId) as {
          description: string;
        }
      ).description,
    ).toBe(description);
    bench.withWriteHandle((db) =>
      db.transaction(() => {
        const row = db.prepare("SELECT revision FROM knowledge_nodes WHERE id=?").get(ownerId) as {
          revision: number;
        };
        enqueueKnowledgeWork(
          db,
          {
            id: "unchanged-proof-repair",
            subjectId: ownerId,
            subjectKind: "node",
            reason: "change",
            inputRevision: String(row.revision),
            tier: "immediate",
            dueAt: Date.now(),
          },
          Date.now(),
        );
      })(),
    );
    await waitFor(
      "unchanged repair completes",
      () =>
        (
          bench.sql
            .prepare("SELECT status FROM knowledge_work WHERE id='unchanged-proof-repair'")
            .get() as { status: string } | undefined
        )?.status === "completed"
          ? true
          : null,
      60_000,
    );
    await bench.drainUntilQuiet();
    expect(count()).toBe(1);
    expect(
      bench.sql
        .prepare(
          "SELECT COUNT(*) AS n FROM knowledge_outcome_assessments WHERE owner_id=? AND status='pass'",
        )
        .get(ownerId),
    ).toEqual({ n: 1 });
  } finally {
    await bench.destroy();
  }
}, 120_000);
