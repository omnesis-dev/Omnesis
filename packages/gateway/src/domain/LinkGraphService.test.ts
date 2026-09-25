// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { resolveLink, resolveInboundLinks, resolveContainingDocument } from "./LinkGraphService.js";
import type { ExtractedLink } from "@omnesis/core";

type Db = Database.Database;

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

const NOW = "2026-01-01T00:00:00Z";

/** Insert a document; `sourceId` defaults to `web:pages`, externalId = id. */
function seedDoc(
  id: string,
  opts: { sourceId?: string; externalId?: string; content?: string } = {},
): void {
  const sourceId = opts.sourceId ?? "web:pages";
  const externalId = opts.externalId ?? id;
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'web', ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
  ).run(id, sourceId, externalId, `Title ${id}`, opts.content ?? "", `h-${id}`, NOW, NOW, NOW, NOW);
}

/** Insert a document carrying an arbitrary `metadata` JSON blob. */
function seedDocWithMetadata(
  id: string,
  metadata: Record<string, unknown>,
  opts: { sourceId?: string; externalId?: string } = {},
): void {
  const sourceId = opts.sourceId ?? "web:pages";
  const externalId = opts.externalId ?? id;
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'web', ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sourceId,
    externalId,
    `Title ${id}`,
    `h-${id}`,
    JSON.stringify(metadata),
    NOW,
    NOW,
    NOW,
    NOW,
  );
}

/** Insert an unresolved `shares-phone` document_links row for `docId`. */
function seedSharesPhoneLink(docId: string, phone: string): void {
  db.prepare(
    `INSERT INTO document_links
       (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, created_at)
     VALUES (?, 'shares-phone', ?, ?, NULL, ?)`,
  ).run(docId, phone, phone, NOW);
}

function linkRows(sourceDocId: string): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM document_links WHERE source_doc_id = ? ORDER BY id")
    .all(sourceDocId) as Array<Record<string, unknown>>;
}

describe("resolveLink — shares-phone", () => {
  test("resolves to another document that also extracted the same normalized phone", () => {
    seedDoc("call-log-doc");
    seedDoc("webpage-doc");
    seedSharesPhoneLink("webpage-doc", "+14155552671");

    const link: ExtractedLink = {
      type: "shares-phone",
      rawTarget: "+14155552671",
      normalizedTarget: "+14155552671",
    };
    const result = resolveLink(db, link, "web:pages", "call-log-doc", []);
    expect(result).toEqual({ docId: "webpage-doc" });
  });

  test("does not resolve to itself", () => {
    seedDoc("only-doc");
    seedSharesPhoneLink("only-doc", "+14155552671");

    const link: ExtractedLink = {
      type: "shares-phone",
      rawTarget: "+14155552671",
      normalizedTarget: "+14155552671",
    };
    const result = resolveLink(db, link, "web:pages", "only-doc", []);
    expect(result).toBeNull();
  });

  test("returns null when no other document mentions the phone", () => {
    seedDoc("alone-doc");
    const link: ExtractedLink = {
      type: "shares-phone",
      rawTarget: "+14155552671",
      normalizedTarget: "+14155552671",
    };
    expect(resolveLink(db, link, "web:pages", "alone-doc", [])).toBeNull();
  });

  test("cross-source by design — resolves regardless of source_id", () => {
    seedDoc("call-doc", { sourceId: "apple-call-log:maya@example.com" });
    seedDoc("email-doc", { sourceId: "gmail:me" });
    seedSharesPhoneLink("email-doc", "+14155552671");

    const link: ExtractedLink = {
      type: "shares-phone",
      rawTarget: "+14155552671",
      normalizedTarget: "+14155552671",
    };
    const result = resolveLink(db, link, "apple-call-log:maya@example.com", "call-doc", []);
    expect(result).toEqual({ docId: "email-doc" });
  });

  test("a phone shared by many documents still resolves cheaply for each (single-target simplification)", () => {
    // Same accepted simplification as `url` links: one source row can only
    // carry one target (schema UNIQUE(source_doc_id, link_type,
    // normalized_target)), so a common number doesn't create a fully
    // connected mesh — each doc resolves to SOME other doc sharing it, not
    // ALL of them. This mirrors resolveUrlLink's `LIMIT 1`.
    seedDoc("doc-a");
    seedDoc("doc-b");
    seedDoc("doc-c");
    seedSharesPhoneLink("doc-a", "+14155552671");
    seedSharesPhoneLink("doc-b", "+14155552671");
    seedSharesPhoneLink("doc-c", "+14155552671");

    const link: ExtractedLink = {
      type: "shares-phone",
      rawTarget: "+14155552671",
      normalizedTarget: "+14155552671",
    };
    const resultForA = resolveLink(db, link, "web:pages", "doc-a", []);
    // Resolves to exactly one of the OTHER docs, not itself.
    expect(["doc-b", "doc-c"]).toContain(resultForA?.docId);
  });
});

describe("resolveInboundLinks — shares-phone", () => {
  test("resolves an existing unresolved shares-phone link when a new document mentions that phone", () => {
    seedDoc("earlier-doc");
    seedSharesPhoneLink("earlier-doc", "+14155552671");
    expect(linkRows("earlier-doc")[0].target_doc_id).toBeNull();

    // A new document arrives whose CONTENT mentions the same phone.
    seedDoc("new-doc", { content: "Call us at +1 415 555 2671 anytime." });
    const resolved = resolveInboundLinks(db, "new-doc", null, "web:pages", "new-doc");

    expect(resolved).toBe(1);
    expect(linkRows("earlier-doc")[0].target_doc_id).toBe("new-doc");
  });

  test("does not resolve when the new document's content mentions a different phone", () => {
    seedDoc("earlier-doc");
    seedSharesPhoneLink("earlier-doc", "+14155552671");

    seedDoc("unrelated-doc", { content: "Call +44 20 7123 4567 instead." });
    const resolved = resolveInboundLinks(db, "unrelated-doc", null, "web:pages", "unrelated-doc");

    expect(resolved).toBe(0);
    expect(linkRows("earlier-doc")[0].target_doc_id).toBeNull();
  });

  test("does not resolve a shares-phone link back to itself", () => {
    seedDoc("self-doc", { content: "Call +1 415 555 2671." });
    seedSharesPhoneLink("self-doc", "+14155552671");

    const resolved = resolveInboundLinks(db, "self-doc", null, "web:pages", "self-doc");
    expect(resolved).toBe(0);
    expect(linkRows("self-doc")[0].target_doc_id).toBeNull();
  });
});

describe("resolveContainingDocument", () => {
  test("a document declaring no parent stands on its own", () => {
    seedDoc("standalone-doc");
    expect(resolveContainingDocument(db, "standalone-doc")).toEqual({ kind: "standalone" });
  });

  test("an attachment resolves to the document it arrived on", () => {
    seedDoc("owning-record", { sourceId: "mail:inbox", externalId: "record-42" });
    seedDocWithMetadata(
      "attached-image",
      { documentType: "attachment", extra: { parentExternalId: "record-42" } },
      { sourceId: "mail:inbox", externalId: "record-42/logo.png" },
    );
    expect(resolveContainingDocument(db, "attached-image")).toEqual({
      kind: "contained",
      parentDocumentId: "owning-record",
    });
  });

  test("containment is scoped to the same source", () => {
    seedDoc("other-source-record", { sourceId: "notes:local", externalId: "record-42" });
    seedDocWithMetadata(
      "attached-elsewhere",
      { extra: { parentExternalId: "record-42" } },
      { sourceId: "mail:inbox", externalId: "record-42/logo.png" },
    );
    expect(resolveContainingDocument(db, "attached-elsewhere")).toEqual({ kind: "orphan" });
  });

  test("an attachment whose parent is not in the corpus is an orphan", () => {
    seedDocWithMetadata(
      "orphan-attachment",
      { extra: { parentExternalId: "record-never-synced" } },
      { sourceId: "mail:inbox", externalId: "record-never-synced/scan.pdf" },
    );
    expect(resolveContainingDocument(db, "orphan-attachment")).toEqual({ kind: "orphan" });
  });

  test("document type alone never declares containment", () => {
    // Both halves of the trap: a document typed `attachment` that declares no
    // container is standalone, and a `file` whose external id merely looks like
    // it sits under another record is standalone too. Only the declared
    // `parentExternalId` relationship counts.
    seedDocWithMetadata("typed-but-unattached", { documentType: "attachment" });
    seedDoc("owning-file-record", { sourceId: "drive:my", externalId: "folder-7" });
    seedDocWithMetadata(
      "drive-file",
      { documentType: "file" },
      { sourceId: "drive:my", externalId: "folder-7/quarterly-plan.pdf" },
    );
    expect(resolveContainingDocument(db, "typed-but-unattached")).toEqual({ kind: "standalone" });
    expect(resolveContainingDocument(db, "drive-file")).toEqual({ kind: "standalone" });
  });

  test("a self-referential or malformed parent declaration means standalone", () => {
    seedDocWithMetadata("self-parent", { extra: { parentExternalId: "self-parent" } });
    seedDocWithMetadata("empty-parent", { extra: { parentExternalId: "" } });
    seedDocWithMetadata("numeric-parent", { extra: { parentExternalId: 42 } });
    expect(resolveContainingDocument(db, "self-parent")).toEqual({ kind: "standalone" });
    expect(resolveContainingDocument(db, "empty-parent")).toEqual({ kind: "standalone" });
    expect(resolveContainingDocument(db, "numeric-parent")).toEqual({ kind: "standalone" });
  });

  test("resolution stops at one level — the parent of a parent is not followed", () => {
    seedDoc("top-record", { sourceId: "mail:inbox", externalId: "top" });
    seedDocWithMetadata(
      "middle-record",
      { extra: { parentExternalId: "top" } },
      { sourceId: "mail:inbox", externalId: "middle" },
    );
    seedDocWithMetadata(
      "leaf-record",
      { extra: { parentExternalId: "middle" } },
      { sourceId: "mail:inbox", externalId: "leaf" },
    );
    expect(resolveContainingDocument(db, "leaf-record")).toEqual({
      kind: "contained",
      parentDocumentId: "middle-record",
    });
  });
});
