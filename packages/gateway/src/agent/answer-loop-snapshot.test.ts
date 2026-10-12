// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDatabase } from "../db.js";
import { createGatewayLoopReadPort } from "../brain/interactive-loop-port.js";
import {
  appendOpenLoopLedger,
  createOpenLoop,
  updateOpenLoop,
} from "../brain/storage/open-loops.js";
import { convertKnowledgeOwner } from "../brain/knowledge/owner-adapters.js";
import { reconcileKnowledgeOwner } from "../brain/knowledge/owner-sync.js";
import { getKnowledgeNode } from "../brain/knowledge/storage-read.js";
import { buildKnowledgeDocumentInput } from "../brain/knowledge/mirror.js";
import { readAnswerLoopSnapshot } from "./answer-loop-snapshot.js";

it.each([false, true])(
  "refreshes a real canonical ledger (projected: %s), but refuses new source associations",
  async (projected) => {
    const directory = mkdtempSync(join(tmpdir(), "loop-observation-"));
    const db = createDatabase(join(directory, "test.db"));
    try {
      createOpenLoop(
        db,
        {
          id: "calibration",
          createdByRun: "fixture",
          title: "Calibrate a laboratory prism",
          description: "Track the calibration request",
          importance: 0.6,
          confidence: 0.8,
        },
        1,
      );
      const project = () => {
        const node = getKnowledgeNode(db, "calibration")!;
        const input = buildKnowledgeDocumentInput(node);
        db.prepare(
          `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at)
        VALUES('projection',?,?,?,?,?,?,?,?,?,'2026-01-01','2026-01-01')
        ON CONFLICT(id) DO UPDATE SET content=excluded.content,content_hash=excluded.content_hash,metadata=excluded.metadata,source_updated_at=excluded.source_updated_at`,
        ).run(
          input.providerId,
          input.sourceId,
          input.externalId,
          input.title,
          input.content,
          input.contentHash,
          JSON.stringify(input.metadata),
          input.sourceCreatedAt,
          input.sourceUpdatedAt,
        );
      };
      if (projected) {
        convertKnowledgeOwner(db, "loop", "calibration", 1);
        reconcileKnowledgeOwner(db, "loop", "calibration", 1);
        project();
      }
      const port = createGatewayLoopReadPort(db);
      const original = await port.fetch("calibration");
      expect(original).not.toBeNull();
      const snapshot = { details: new Map([["calibration", JSON.stringify(original)]]) };
      appendOpenLoopLedger(
        db,
        "calibration",
        { runId: "fixture", note: "Calibration slot recorded" },
        2,
      );
      if (projected) {
        reconcileKnowledgeOwner(db, "loop", "calibration", 2);
        project();
      }
      if (projected) {
        const after = await port.fetch("calibration");
        const beforeContext = { ...original!.knowledgeContext };
        const afterContext = { ...after!.knowledgeContext };
        delete beforeContext.revision;
        delete afterContext.revision;
        expect(afterContext).toEqual(beforeContext);
      }
      const refreshed = await readAnswerLoopSnapshot(
        snapshot,
        port,
        new AbortController().signal,
        65536,
      );
      expect(refreshed?.changed).toBe(true);
      const detail = JSON.parse(refreshed!.snapshot.details.get("calibration")!);
      expect(detail.ledger).toEqual([{ at: 2, note: "Calibration slot recorded" }]);
      expect(detail.docIds).toEqual(original!.docIds);
      if (projected) {
        expect(original!.knowledgeContext).toMatchObject({
          nodeId: "calibration",
          kind: "loop",
          revision: 2,
          validity: "current",
        });
        expect(detail.knowledgeContext.revision).toBe(3);
        const newerObservation = {
          ...original!,
          knowledgeContext: { ...original!.knowledgeContext, revision: 4 },
        };
        expect(
          await readAnswerLoopSnapshot(
            { details: new Map([["calibration", JSON.stringify(newerObservation)]]) },
            port,
            new AbortController().signal,
            65536,
          ),
        ).toBeNull();
        const staleObservation = {
          ...original!,
          knowledgeContext: { ...original!.knowledgeContext, validity: "stale" },
        };
        expect(
          await readAnswerLoopSnapshot(
            { details: new Map([["calibration", JSON.stringify(staleObservation)]]) },
            port,
            new AbortController().signal,
            65536,
          ),
        ).toBeNull();
        const { revision: _oldRevision, ...oldAuthority } = original!.knowledgeContext!;
        const { revision: _newRevision, ...newAuthority } = detail.knowledgeContext;
        expect(newAuthority).toEqual(oldAuthority);
        for (const field of ["provenance", "verifiedSupport", "validity", "navigation"] as const) {
          const altered = structuredClone(detail);
          altered.knowledgeContext[field] = field === "validity" ? "stale" : { changed: true };
          expect(
            await readAnswerLoopSnapshot(
              snapshot,
              { ...port, fetch: async () => altered },
              new AbortController().signal,
              65536,
            ),
          ).toBeNull();
        }
      } else expect(detail.knowledgeContext).toEqual(original!.knowledgeContext);
      updateOpenLoop(db, "calibration", { docs: ["new-observation"] }, 3);
      expect(
        await readAnswerLoopSnapshot(snapshot, port, new AbortController().signal, 65536),
      ).toBeNull();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
