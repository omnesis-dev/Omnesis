// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { z } from "zod";
import { docBodySchema, type ToolResult, type TrailEvent } from "@omnesis/core";
import type { RecordPort, ToolHandle, ToolPorts } from "@omnesis/agent";
import type { FindSearchResult } from "./types.js";

const referenceSchema = z.object({
  table: z.string().min(1).max(256),
  recordKey: z.string().min(1).max(4096),
  primaryKeyColumns: z
    .array(
      z.object({
        name: z.string().min(1).max(256),
        value: z.string().max(4096),
        castType: z.string().max(256).optional(),
      }),
    )
    .min(1)
    .max(16),
});

export const browserResultsSchema = z.object({
  results: z
    .array(
      z.object({
        destinationUrl: z.string().min(1).max(4096),
        title: z
          .string()
          .min(1)
          .max(512)
          .describe(
            "Use the evidence document title or a verbatim body span; unsupported titles fall back to the document title",
          ),
        snippet: z.string().max(1200).optional(),
        // The shared model-schema converter exposes objects but not unions.
        // Keep both supported receipt shapes visible to every backend.
        evidence: z
          .object({
            documentIds: z
              .array(z.string().min(1).max(512))
              .min(1)
              .max(8)
              .optional()
              .describe(
                "Supporting document IDs returned by a retrieval tool; omit when using a record",
              ),
            record: referenceSchema
              .optional()
              .describe(
                "Copy one exact rowIdentities reference from run_sql; omit when using document IDs",
              ),
          })
          .superRefine((evidence, ctx) => {
            if ((evidence.documentIds === undefined) === (evidence.record === undefined)) {
              ctx.addIssue({
                code: "custom",
                message: "Provide exactly one of documentIds or record",
              });
            }
          }),
      }),
    )
    .max(20),
});

type Reference = z.infer<typeof referenceSchema>;
type Snapshot = Record<string, string | number | boolean | null>;

function referenceKey(reference: Reference): string {
  return JSON.stringify([
    reference.table,
    reference.recordKey,
    [...reference.primaryKeyColumns]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, value }) => [name, value]),
  ]);
}

function browserUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function containsUrl(text: string, destination: string): boolean {
  const candidates = text.match(/https?:\/\/[^\s<>"'`]+/g) ?? [];
  return candidates.some((candidate) => {
    for (let trims = 0; trims <= 8; trims++) {
      if (browserUrl(candidate) === destination) return true;
      if (!/[),.;\]]$/.test(candidate)) break;
      const last = candidate.at(-1);
      if (
        last === ")" &&
        (candidate.match(/\)/g)?.length ?? 0) <= (candidate.match(/\(/g)?.length ?? 0)
      )
        break;
      if (
        last === "]" &&
        (candidate.match(/\]/g)?.length ?? 0) <= (candidate.match(/\[/g)?.length ?? 0)
      )
        break;
      candidate = candidate.slice(0, -1);
    }
    return false;
  });
}

/** Turn-local receipts ensure an output cannot invent its evidence identity. */
export class BrowserFindEvidence {
  readonly documentIds = new Set<string>();
  readonly records = new Map<string, { reference: Reference; snapshot: Snapshot }>();
  private exhausted = false;

  private addDocument(id: string): void {
    if (this.documentIds.size >= 5000 && !this.documentIds.has(id)) {
      this.exhausted = true;
      return;
    }
    this.documentIds.add(id);
  }

  get budgetExhausted(): boolean {
    return this.exhausted;
  }

  private observeTrail(event: TrailEvent): void {
    if (event.doc) this.addDocument(event.doc.documentId);
    if (event.record?.boundDocumentId) this.addDocument(event.record.boundDocumentId);
    for (const related of event.related) this.addDocument(related.documentId);
    for (const attachment of event.attachments) this.observeTrail(attachment);
  }

  observe(result: ToolResult): void {
    switch (result.kind) {
      case "document":
        this.addDocument(result.ref.documentId);
        break;
      case "search.results":
        for (const ref of result.results) this.addDocument(ref.documentId);
        break;
      case "document.byUrl":
        if (result.ref) this.addDocument(result.ref.documentId);
        break;
      case "search.batch":
      case "document.batch":
        for (const item of result.items) this.observe(item);
        break;
      case "sql.rows":
        result.rows.forEach((row, index) => {
          const reference = result.rowIdentities?.[index];
          if (!reference) return;
          const snapshot: Snapshot = {};
          result.columns.forEach((column, columnIndex) => {
            const value = row[columnIndex];
            if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
              snapshot[column] = value as Snapshot[string];
            }
          });
          const key = referenceKey(reference);
          if (this.records.size >= 1000 && !this.records.has(key)) {
            this.exhausted = true;
            return;
          }
          this.records.set(key, {
            reference: {
              ...reference,
              primaryKeyColumns: reference.primaryKeyColumns.map((column) => ({ ...column })),
            },
            snapshot,
          });
        });
        break;
      case "event_trail.built":
        for (const event of result.events) this.observeTrail(event);
        break;
      case "structured": {
        if (result.resultType !== "temporal.results") break;
        const parsed = z
          .object({ items: z.array(z.object({ documentIds: z.array(z.string()) })) })
          .safeParse(result.data);
        if (parsed.success)
          for (const item of parsed.data.items)
            for (const id of item.documentIds) this.addDocument(id);
        break;
      }
      default:
        // Other retrieval results are informative, but cannot authorize a destination.
        break;
    }
  }

  wrap(tool: ToolHandle): ToolHandle {
    return {
      ...tool,
      invoke: async (args, context) => {
        const result = await tool.invoke(args, context);
        this.observe(result);
        return result;
      },
    };
  }
}

export function createBrowserResultsTool(options: {
  evidence: BrowserFindEvidence;
  ports: Pick<ToolPorts, "document" | "record">;
  limit?: number;
  onResults(results: FindSearchResult[]): void;
}): ToolHandle {
  const presented = new Map<string, FindSearchResult>();
  const limit = Math.max(1, Math.min(20, options.limit ?? 20));
  return {
    name: "present_browser_results",
    mutates: false,
    description:
      "Present the final clickable browser search results. Call even when results are empty. " +
      "Every HTTP(S) destination must be a retrieved document's source URL or an exact URL in its body. " +
      "For SQL results copy a rowIdentities reference; the destination must match that row's bound document. " +
      "Use the source document title or a verbatim body span as the title; other titles fall back to the source title. " +
      "A snippet must be a verbatim passage from the supporting document. Never invent URLs or evidence.",
    schema: browserResultsSchema,
    async invoke(raw, context): Promise<ToolResult> {
      const parsed = browserResultsSchema.safeParse(raw);
      if (!parsed.success)
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")
            .slice(0, 1000),
        };
      const results: FindSearchResult[] = [];
      for (const item of parsed.data.results) {
        if (context.abortSignal?.aborted)
          return { kind: "error", code: "canceled", message: "Search canceled" };
        const url = browserUrl(item.destinationUrl);
        if (!url)
          return {
            kind: "error",
            code: "ungrounded_destination",
            message: "Use a credential-free HTTP(S) evidence URL",
          };
        let ids: string[];
        let identity: string;
        if (item.evidence.record !== undefined) {
          const reference = item.evidence.record;
          const receipt = options.evidence.records.get(referenceKey(reference));
          if (!receipt || !options.ports.record)
            return {
              kind: "error",
              code: "unretrieved_evidence",
              message: options.evidence.budgetExhausted
                ? "This search reached its evidence budget; use already retained results"
                : "Retrieve an identifiable SQL row first",
            };
          let record: Awaited<ReturnType<RecordPort["resolve"]>>;
          try {
            record = await options.ports.record.resolve(receipt);
          } catch {
            return {
              kind: "error",
              code: "unsupported_record",
              message: "This row cannot resolve a source-bound browser destination",
            };
          }
          if (!record.boundDocumentId)
            return {
              kind: "error",
              code: "ungrounded_destination",
              message: "This record has no source-bound browser document",
            };
          ids = [record.boundDocumentId];
          identity = referenceKey(reference);
        } else {
          ids = item.evidence.documentIds ?? [];
          if (ids.some((id) => !options.evidence.documentIds.has(id)))
            return {
              kind: "error",
              code: "unretrieved_evidence",
              message: options.evidence.budgetExhausted
                ? "This search reached its evidence budget; use already retained results"
                : "Retrieve the supporting documents first",
            };
          identity = [...ids].sort().join("\n");
        }
        const documents = await Promise.all(ids.map((id) => options.ports.document.fetch(id)));
        const matched = documents.find((document) => {
          if (!document) return false;
          const parsedBody = docBodySchema.safeParse(document.document);
          const content = parsedBody.success ? parsedBody.data.content : undefined;
          return (
            browserUrl(document.ref.url ?? "") === url ||
            (typeof content === "string" && containsUrl(content, url))
          );
        });
        if (!matched)
          return {
            kind: "error",
            code: "ungrounded_destination",
            message: "Destination is absent from the authoritative evidence",
          };
        const parsedBody = docBodySchema.safeParse(matched.document);
        const content = parsedBody.success ? (parsedBody.data.content ?? "") : "";
        if (item.snippet && !content.includes(item.snippet))
          return {
            kind: "error",
            code: "ungrounded_snippet",
            message: "Use a verbatim evidence passage as the snippet",
          };
        results.push({
          id: createHash("sha256").update(`${url}\n${identity}`).digest("hex"),
          documentId: matched.ref.documentId,
          title:
            item.title === matched.ref.title || content.includes(item.title)
              ? item.title
              : matched.ref.title?.slice(0, 512) || url,
          sourceUrl: url,
          sourceId: matched.ref.sourceId,
          chunkText: item.snippet ?? content.slice(0, 600),
          sourceCreatedAt: parsedBody.success ? parsedBody.data.sourceCreatedAt : undefined,
          evidence: documents.flatMap((document) =>
            document
              ? [
                  {
                    documentId: document.ref.documentId,
                    title: document.ref.title ?? "Untitled",
                    sourceUrl: document.ref.url,
                  },
                ]
              : [],
          ),
        });
      }
      if (context.abortSignal?.aborted)
        return { kind: "error", code: "canceled", message: "Search canceled" };
      const next = new Map(presented);
      for (const result of results) next.set(result.id, result);
      if (next.size > limit)
        return {
          kind: "error",
          code: "too_many_results",
          message: `Present at most ${limit} destinations in this search`,
        };
      for (const [id, result] of next) presented.set(id, result);
      options.onResults([...presented.values()]);
      return { kind: "structured", resultType: "browser.results", data: { count: presented.size } };
    },
  };
}
