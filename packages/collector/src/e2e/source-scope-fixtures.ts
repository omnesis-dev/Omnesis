// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import type { ScopeRef, SourceScopeUpdates, DocumentMetadata } from "@omnesis/types";
import type { SyntheticE2EHarness, PushDocumentInput } from "./synth-harness.js";

export const SCOPED_SOURCE_TYPES = [
  "whatsapp-messages",
  "apple-imessage",
  "gmail",
  "google-drive",
] as const;
export type ScopedSourceType = (typeof SCOPED_SOURCE_TYPES)[number];
export interface ScopeFixtureSample {
  id: string;
  externalId: string;
  kind: "selected" | "other" | "unknown";
  body: string;
  attachment: boolean;
}
export interface ScopeFixture {
  type: ScopedSourceType;
  sourceId: string;
  providerId: string;
  samples: ScopeFixtureSample[];
  ref: ScopeRef;
}
interface SyncState {
  cursor?: Record<string, unknown>;
  wipeEpoch: number;
  scopeRefreshEpochs?: Partial<Record<"label" | "folder" | "participant", string>>;
}

/** Submit native metadata through the same cursor path collectors use; keep their content cursor intact. */
export async function pushScopeUpdates(
  harness: SyntheticE2EHarness,
  source: Pick<ScopeFixture, "sourceId" | "providerId">,
  scopeUpdates: SourceScopeUpdates,
): Promise<void> {
  const state = await harness.gatewayJson<SyncState>(
    `/sync-state/${encodeURIComponent(source.sourceId)}`,
  );
  const result = await harness.gatewayJson<{ rejected?: boolean }>("/documents/with-cursor", {
    method: "POST",
    body: JSON.stringify({
      providerId: source.providerId,
      sourceId: source.sourceId,
      documents: [],
      deletedExternalIds: [],
      cursor: state.cursor ?? {},
      wipeEpoch: state.wipeEpoch,
      hasMore: false,
      scopeUpdates,
    }),
  });
  if (result.rejected) throw new Error("Synthetic scope metadata was rejected.");
}

/** Invented selected/other/unknown parents and inherited attachments on a real synthetic account. */
export async function seedScopeFixture(
  harness: SyntheticE2EHarness,
  type: ScopedSourceType,
): Promise<ScopeFixture> {
  const sourceId = harness.getSourceIds().find((id) => id.startsWith(`${type}:`));
  if (!sourceId) throw new Error(`Missing synthetic source ${type}`);
  await harness.triggerSyncAndWait(sourceId);
  const reader = new Database(harness.getDbPath(), { readonly: true });
  let providerId: string;
  try {
    const row = reader
      .prepare<[string], { provider_id: string }>(
        "SELECT provider_id FROM documents WHERE source_id=? LIMIT 1",
      )
      .get(sourceId);
    if (!row) throw new Error(`Synthetic source ${type} produced no documents`);
    providerId = row.provider_id;
  } finally {
    reader.close();
  }
  const state = await harness.gatewayJson<SyncState>(`/sync-state/${encodeURIComponent(sourceId)}`);
  const selectedId = `scopefixture-${type}-selected`;
  const otherId = `scopefixture-${type}-other`;
  const ref: ScopeRef =
    type === "gmail"
      ? { kind: "label", id: selectedId }
      : type === "google-drive"
        ? { kind: "folder", id: selectedId }
        : { kind: "conversation", id: selectedId };
  if (type === "google-drive")
    await pushScopeUpdates(
      harness,
      { sourceId, providerId },
      {
        hierarchy: {
          kind: "folder",
          refreshEpoch: state.scopeRefreshEpochs?.folder,
          nodes: [
            { id: selectedId, label: "Invented selected folder", parentIds: [], complete: true },
            {
              id: `${selectedId}-child`,
              label: "Invented descendant folder",
              parentIds: [selectedId],
              complete: true,
            },
            {
              id: `${selectedId}-grandchild`,
              label: "Invented nested descendant",
              parentIds: [`${selectedId}-child`],
              complete: true,
            },
            { id: otherId, label: "Invented other folder", parentIds: [], complete: true },
          ],
        },
      },
    );
  const samples: Array<Omit<ScopeFixtureSample, "id">> = [];
  const inputs: PushDocumentInput[] = [];
  for (const kind of ["selected", "other", "unknown"] as const) {
    const externalId = `scopefixture-${type}-${kind}`;
    const body = `scopefixture SCOPETOKEN_${type.replaceAll("-", "_")}_${kind.toUpperCase()} invented record`;
    const complete = kind !== "unknown";
    const metadata: DocumentMetadata = {
      sourceUrl: `https://example.org/scoped-fixtures/${externalId}`,
    };
    if (type === "gmail") {
      metadata.documentType = "email";
      metadata.people = complete
        ? [
            {
              role: "sender",
              name: `Invented ${kind}`,
              emails: [`${kind}@example.org`],
            },
          ]
        : [];
      metadata.scopeFacts = {
        kinds: complete ? ["label"] : ["label", "participant"],
        facts: complete ? [{ kind: "label", id: externalId, label: `Invented ${kind}` }] : [],
        complete: complete ? ["label"] : [],
        ...(state.scopeRefreshEpochs?.label
          ? { refreshEpochs: { label: state.scopeRefreshEpochs.label } }
          : {}),
      };
    } else if (type === "google-drive") {
      metadata.documentType = "file";
      if (complete)
        metadata.scopeHierarchy = [
          {
            kind: "folder",
            parentIds: [kind === "selected" ? `${selectedId}-child` : otherId],
            complete: true,
            refreshEpoch: state.scopeRefreshEpochs?.folder,
          },
        ];
    } else {
      metadata.documentType = "conversation";
      if (complete)
        metadata.extra = {
          conversationId: externalId,
          chatId: externalId,
          chatName: `Invented ${kind}`,
        };
      metadata.people = complete
        ? [
            {
              role: "participant",
              name: "Invented correspondent",
              phones: [kind === "selected" ? "+447700900123" : "+447700900456"],
            },
          ]
        : [];
    }
    inputs.push({
      sourceId,
      providerId,
      externalId,
      title: `scopefixture ${type} ${kind}`,
      content: body,
      metadata: { ...metadata },
    });
    samples.push({ externalId, kind, body, attachment: false });
    if (complete) {
      const child = `${externalId}/att/invented`;
      const childBody = `${body} attachment`;
      inputs.push({
        sourceId,
        providerId,
        externalId: child,
        title: `scopefixture ${type} ${kind} attachment`,
        content: childBody,
        metadata: {
          documentType: "attachment",
          extra: { parentExternalId: externalId, mimeType: "text/plain" },
        },
      });
      samples.push({ externalId: child, kind, body: childBody, attachment: true });
    }
  }
  if (type === "google-drive") {
    const externalId = `${selectedId}-deep`;
    const body = "scopefixture SCOPETOKEN_google_drive_SELECTED_DEEP invented nested record";
    inputs.push({
      sourceId,
      providerId,
      externalId,
      title: "scopefixture nested file",
      content: body,
      metadata: {
        documentType: "file",
        sourceUrl: `https://example.org/scoped-fixtures/${externalId}`,
        scopeHierarchy: [
          {
            kind: "folder",
            parentIds: [`${selectedId}-grandchild`],
            complete: true,
            refreshEpoch: state.scopeRefreshEpochs?.folder,
          },
        ],
      },
    });
    samples.push({ externalId, kind: "selected", body, attachment: false });
    const attachmentId = `${externalId}/att/invented`;
    const attachmentBody = `${body} attachment`;
    inputs.push({
      sourceId,
      providerId,
      externalId: attachmentId,
      title: "scopefixture nested attachment",
      content: attachmentBody,
      metadata: {
        documentType: "attachment",
        extra: { parentExternalId: externalId, mimeType: "text/plain" },
      },
    });
    samples.push({
      externalId: attachmentId,
      kind: "selected",
      body: attachmentBody,
      attachment: true,
    });
  }
  await harness.pushDocuments(inputs);
  if (type === "whatsapp-messages" || type === "apple-imessage") {
    await pushScopeUpdates(
      harness,
      { sourceId, providerId },
      {
        conversations: ["selected", "other"].map((kind) => ({
          id: `scopefixture-${type}-${kind}`,
          mode: "snapshot" as const,
          observedAt: "2026-01-01T00:00:00Z",
          revision: { epoch: `invented-fixture-${type}`, sequence: 1 },
          refreshEpoch: state.scopeRefreshEpochs?.participant,
          participants: [
            {
              role: "participant" as const,
              phones: [kind === "selected" ? "+447700900123" : "+447700900456"],
            },
          ],
        })),
      },
    );
  }
  const source: ScopeFixture = { type, sourceId, providerId, ref, samples: [] };
  const db = new Database(harness.getDbPath(), { readonly: true });
  try {
    for (const sample of samples) {
      const row = db
        .prepare<[string, string], { id: string }>(
          "SELECT id FROM documents WHERE source_id=? AND external_id=?",
        )
        .get(sourceId, sample.externalId);
      if (!row) throw new Error(`Missing scope fixture ${sample.externalId}`);
      source.samples.push({ ...sample, id: row.id });
    }
  } finally {
    db.close();
  }
  // A completed native pass may contain intentionally unresolved rows; those remain individually unknown.
  if (type === "gmail" || type === "google-drive")
    await pushScopeUpdates(harness, source, {
      readiness: [{ kind: type === "gmail" ? "label" : "folder", complete: true }],
    });
  return source;
}

export async function prepareScopeSearch(
  harness: SyntheticE2EHarness,
  sources: ScopeFixture[],
): Promise<void> {
  for (let tick = 0; tick < 80; tick++) {
    await harness.gatewayJson("/admin/background/run/backfill.scopeFacts", { method: "POST" });
    const db = new Database(harness.getDbPath(), { readonly: true });
    let ready: boolean;
    try {
      ready = sources.every(
        (source) =>
          !!db
            .prepare("SELECT 1 FROM scope_fact_backfill WHERE source_id=? AND ready=1")
            .get(source.sourceId),
      );
    } finally {
      db.close();
    }
    if (ready) {
      for (const source of sources)
        if (source.type === "gmail" || source.type === "google-drive")
          await pushScopeUpdates(harness, source, {
            readiness: [{ kind: source.type === "gmail" ? "label" : "folder", complete: true }],
          });
      await harness.reindexMissing();
      await harness.refreshSearchSnapshot();
      return;
    }
  }
  throw new Error("Synthetic scope preparation did not finish");
}

/** A native metadata-only change: no document body is rewritten. */
export async function hideSelectedScopeFixture(
  harness: SyntheticE2EHarness,
  source: ScopeFixture,
): Promise<void> {
  const state = await harness.gatewayJson<SyncState>(
    `/sync-state/${encodeURIComponent(source.sourceId)}`,
  );
  const selected = source.samples.find(
    (sample) => sample.kind === "selected" && !sample.attachment,
  )!;
  if (source.type === "gmail") {
    await pushScopeUpdates(harness, source, {
      documents: [
        {
          externalId: selected.externalId,
          kinds: ["label"],
          facts: {
            kinds: ["label"],
            complete: ["label"],
            facts: [
              {
                kind: "label",
                id: `scopefixture-${source.type}-replacement`,
                label: "Invented selected",
              },
            ],
            refreshEpochs: state.scopeRefreshEpochs,
          },
        },
      ],
    });
  } else if (source.type === "google-drive") {
    await pushScopeUpdates(harness, source, {
      hierarchy: {
        kind: "folder",
        refreshEpoch: state.scopeRefreshEpochs?.folder,
        nodes: [
          {
            id: `${source.ref.kind === "folder" ? source.ref.id : ""}-child`,
            label: "Invented descendant folder",
            parentIds: [`scopefixture-${source.type}-other`],
            complete: true,
          },
        ],
      },
    });
  } else {
    await pushScopeUpdates(harness, source, {
      conversations: [
        {
          id: selected.externalId,
          mode: "snapshot",
          observedAt: "2026-01-03T00:00:00Z",
          revision: { epoch: `invented-fixture-${source.type}`, sequence: 4 },
          refreshEpoch: state.scopeRefreshEpochs?.participant,
          participants: [{ role: "participant", phones: ["+447700900456"] }],
        },
      ],
    });
  }
}
