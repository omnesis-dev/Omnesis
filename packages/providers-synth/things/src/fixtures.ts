// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  sha256Hex,
  personMention,
  loadActiveUniverse,
  loadSourceFixtureJson,
} from "@omnesis/providers-synth-common";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

interface TaskEntry {
  externalId: string;
  title: string;
  notes: string;
  createdAt: string;
  modifiedAt: string;
  scheduledAt?: string | null;
  deadline: string | null;
  project: string;
  tags: string[];
  status: "open" | "done" | "cancelled";
}

let cached: TaskEntry[] | null = null;

export function loadTasks(): TaskEntry[] {
  if (cached) return cached;
  cached = loadSourceFixtureJson<TaskEntry[]>(loadActiveUniverse(), "things", "tasks.json");
  return cached;
}

export function mapTask(
  e: TaskEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  const content = e.notes ? `${e.title}\n\n${e.notes}` : e.title;
  const status = e.status === "done" ? "completed" : e.status === "cancelled" ? "canceled" : "open";
  const dueAt = e.deadline?.slice(0, 10);
  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: e.title,
    content,
    contentHash: sha256Hex(`${e.externalId}:${content}:${e.modifiedAt}:${e.status}`),
    metadata: {
      documentType: "task",
      scheduledAt: e.scheduledAt ?? undefined,
      dueAt,
      status,
      tags: e.tags,
      people: [personMention("self", "author")],
      extra: {
        status,
        project: e.project,
        deadline: dueAt,
        scheduled: e.scheduledAt ?? undefined,
      },
    },
    sourceCreatedAt: canonicalUtc(e.createdAt),
    sourceUpdatedAt: canonicalUtc(e.modifiedAt),
  };
}

/**
 * The stamp in the canonical form the shipped source emits.
 *
 * Things declares `replicaVersionPolicy: "source-updated-at"`, so the gateway
 * compares replica versions as strings and refuses a page whose
 * `sourceUpdatedAt` is not the canonical UTC rendering. The real provider
 * satisfies that for free — it derives the stamp from a unix timestamp — while
 * a fixture is hand-written and reaches here at whatever precision it was
 * typed at. Rendering it the same way keeps the synthetic source honest
 * against the same guard production meets.
 */
function canonicalUtc(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`things fixture carries an unparseable timestamp: ${value}`);
  }
  return parsed.toISOString();
}
