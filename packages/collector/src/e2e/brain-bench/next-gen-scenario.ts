// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { BrainBench } from "./bench.js";

const documentSchema = z
  .object({
    externalId: z.string().min(1),
    title: z.string().min(1),
    content: z.string().min(1),
    createdMinute: z.number().int(),
  })
  .strict();
const upsertSchema = z
  .object({
    kind: z.literal("upsert"),
    document: z.string().min(1),
    content: z.string().min(1).optional(),
    updatedMinute: z.number().int().optional(),
    expectAbsent: z.boolean().optional(),
  })
  .strict();
const deleteSchema = z.object({ kind: z.literal("delete"), document: z.string().min(1) }).strict();
export const nextGenScenarioSchema = z
  .object({
    version: z.literal(1),
    universe: z.literal("sacha-bellamy"),
    epoch: z.string().datetime(),
    documents: z.record(z.string(), documentSchema),
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1),
            minute: z.number().int().nonnegative(),
            operations: z.array(z.discriminatedUnion("kind", [upsertSchema, deleteSchema])),
            expectations: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    const stepIds = new Set<string>();
    const externalIds = new Set<string>();
    for (const doc of Object.values(scenario.documents)) {
      if (externalIds.has(doc.externalId))
        ctx.addIssue({ code: "custom", message: "Duplicate external ID" });
      externalIds.add(doc.externalId);
    }
    let previousMinute = -1;
    const present = new Set<string>();
    const deleted = new Set<string>();
    for (const step of scenario.steps) {
      if (stepIds.has(step.id)) ctx.addIssue({ code: "custom", message: "Duplicate step ID" });
      stepIds.add(step.id);
      if (step.minute < previousMinute)
        ctx.addIssue({ code: "custom", message: "Arrival clock must not go backward" });
      previousMinute = step.minute;
      for (const op of step.operations) {
        const doc = scenario.documents[op.document];
        if (!doc) {
          ctx.addIssue({ code: "custom", message: `Unknown document ${op.document}` });
          continue;
        }
        if (op.kind === "delete") {
          if (!present.has(op.document))
            ctx.addIssue({ code: "custom", message: "Delete requires a present document" });
          present.delete(op.document);
          deleted.add(op.document);
        } else {
          const updated = op.updatedMinute ?? doc.createdMinute;
          if (updated < doc.createdMinute || updated > step.minute)
            ctx.addIssue({
              code: "custom",
              message: "Source update must fall between creation and arrival",
            });
          if (op.expectAbsent) {
            if (!deleted.has(op.document))
              ctx.addIssue({
                code: "custom",
                message: "Suppressed resurrection requires a prior privacy delete",
              });
          } else {
            if (deleted.has(op.document))
              ctx.addIssue({
                code: "custom",
                message: "Privacy-deleted documents cannot be implicitly restored",
              });
            present.add(op.document);
          }
        }
      }
    }
  });

export type NextGenScenario = z.infer<typeof nextGenScenarioSchema>;
export type NextGenScenarioStep = NextGenScenario["steps"][number];

export function loadNextGenScenario(): NextGenScenario {
  const path = fileURLToPath(
    new URL(
      "../../../../../evals/universes/sacha-bellamy/next-gen-brain/scenario.json",
      import.meta.url,
    ),
  );
  return nextGenScenarioSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export interface NextGenScenarioCheckpoint {
  step: NextGenScenarioStep;
  /** Gateway IDs already observed, including IDs of subsequently deleted documents. */
  documentIds: ReadonlyMap<string, string>;
  arrivalTime: number;
}

/**
 * Drives real ingestion and privacy deletion against an already running BrainBench.
 * The bench MUST use clock:"virtual" and the sacha-bellamy universe. Models belong
 * to the caller's deterministic puppet/decision servers; this helper never mocks
 * engine state or executes an inference call itself.
 *
 * Checkpoints deliberately do not drain the queue automatically: queued hourly and
 * routine work must remain queued until due. The caller asserts immediate state and
 * waits for the specific maintenance marker/API condition relevant to each step.
 */
export class NextGenScenarioDriver {
  private readonly ids = new Map<string, string>();
  private nextStep = 0;

  constructor(
    private readonly bench: BrainBench,
    readonly scenario: NextGenScenario,
    private readonly source: { providerId: string; sourceId: string },
  ) {}

  async advance(): Promise<NextGenScenarioCheckpoint | null> {
    const step = this.scenario.steps[this.nextStep];
    if (!step) return null;
    const epoch = Date.parse(this.scenario.epoch);
    const arrivalTime = epoch + step.minute * 60_000;
    await this.bench.clock.set(arrivalTime);
    // Adjacent upserts land in one production request. A delete is an ordering
    // barrier so a scenario cannot accidentally recreate before deleting.
    let pending: Extract<NextGenScenarioStep["operations"][number], { kind: "upsert" }>[] = [];
    const flush = async (): Promise<void> => {
      if (!pending.length) return;
      await this.bench.harness.pushDocuments(
        pending.map((op) => {
          const doc = this.scenario.documents[op.document]!;
          return {
            ...this.source,
            externalId: doc.externalId,
            title: doc.title,
            content: op.content ?? doc.content,
            documentType: "email",
            sourceCreatedAt: new Date(epoch + doc.createdMinute * 60_000).toISOString(),
            sourceUpdatedAt: new Date(
              epoch + (op.updatedMinute ?? doc.createdMinute) * 60_000,
            ).toISOString(),
            // No desired outcomes, gate answers, or fixture labels leak into evidence.
            metadata: { documentType: "email" },
          };
        }),
      );
      for (const op of pending) {
        const doc = this.scenario.documents[op.document]!;
        if (op.expectAbsent) {
          const present = this.bench.sql
            .prepare("SELECT id FROM documents WHERE source_id = ? AND external_id = ?")
            .get(this.source.sourceId, doc.externalId);
          if (present) throw new Error(`Privacy-deleted source was resurrected: ${op.document}`);
        } else {
          const id = await this.bench.docId(doc.externalId);
          const previous = this.ids.get(op.document);
          if (previous && previous !== id)
            throw new Error(`Source update changed identity: ${op.document}`);
          this.ids.set(op.document, id);
        }
      }
      pending = [];
    };
    for (const op of step.operations) {
      if (op.kind === "upsert") pending.push(op);
      else {
        await flush();
        const id = this.ids.get(op.document);
        if (!id) throw new Error(`Missing ingested document before delete: ${op.document}`);
        await this.bench.deleteDoc(id);
      }
    }
    await flush();
    this.nextStep++;
    return { step, documentIds: new Map(this.ids), arrivalTime };
  }

  async run(checkpoint: (value: NextGenScenarioCheckpoint) => Promise<void>): Promise<void> {
    let next: NextGenScenarioCheckpoint | null;
    while ((next = await this.advance())) await checkpoint(next);
  }
}
