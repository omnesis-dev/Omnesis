// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

type Db = Database.Database;

import { createDatabase } from "../db.js";
import { createCorpusAuthorization } from "../access/corpus-authorization.js";
import { createGatewayDocumentByUrlPort } from "./ports.js";

const authorization = createCorpusAuthorization(
  {
    principalId: "principal-example",
    grantId: "grant-example",
    grantRevision: 1,
    credentialId: "credential-example",
    accessTokenId: "token-example",
  },
  [
    {
      capability: "direct",
      sourceMode: "allowlist",
      sourceIds: ["mail:allowed"],
      releaseMode: null,
      policyFamilyId: null,
      policyRevision: null,
      privacyPolicy: null,
    },
  ],
  "direct",
)!;

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-doc-by-url-port-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function insertDocument(args: {
  id: string;
  sourceId: string;
  title: string;
  content: string;
  sourceUrl: string;
  documentType?: string;
  mimeType?: string;
}) {
  const metadata = JSON.stringify({
    sourceUrl: args.sourceUrl,
    documentType: args.documentType ?? "file",
    ...(args.mimeType ? { extra: { mimeType: args.mimeType } } : {}),
  });
  // A restricted grant reads only configured sources, so each document's
  // source is registered the way a collector would have declared it.
  db.prepare(
    "INSERT OR IGNORE INTO devices (id, name, kind, paired_at) VALUES ('00000000-0000-4000-8000-000000000001', 'Test device', 'desktop', 1)",
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO sources (id, type, account_id, device_id, created_at, updated_at)
     VALUES (?, ?, ?, '00000000-0000-4000-8000-000000000001', 1, 1)`,
  ).run(
    args.sourceId,
    args.sourceId.split(":", 1)[0],
    args.sourceId.includes(":") ? args.sourceId.slice(args.sourceId.indexOf(":") + 1) : "test",
  );
  db.prepare(
    `INSERT INTO documents
       (id, provider_id, source_id, external_id, title, content, content_hash,
        metadata, source_url, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test', ?, ?, ?, ?, 'hash-' || ?, ?, ?, '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01')`,
  ).run(
    args.id,
    args.sourceId,
    args.id,
    args.title,
    args.content,
    args.id,
    metadata,
    args.sourceUrl,
  );
}

describe("createGatewayDocumentByUrlPort.lookup", () => {
  test("returns a DocRef for a URL that resolves to one document", async () => {
    insertDocument({
      id: "doc-drive-1",
      sourceId: "google-drive:self",
      title: "Vendor evaluation matrix",
      content: "Vendor,Throughput,SOC2\nGlobex,High,Pending Nov",
      sourceUrl: "https://drive.google.com/file/d/synth-gdrive-002/view",
      documentType: "file",
    });

    const port = createGatewayDocumentByUrlPort(db);
    const out = await port.lookup("https://drive.google.com/file/d/synth-gdrive-002/view");

    expect(out.url).toBe("https://drive.google.com/file/d/synth-gdrive-002/view");
    expect(out.ref).toBeDefined();
    expect(out.ref?.documentId).toBe("doc-drive-1");
    expect(out.ref?.sourceType).toBe("google-drive");
    expect(out.ref?.title).toBe("Vendor evaluation matrix");
    expect(out.ref?.documentType).toBe("file");
    // Body is truncated to snippet length (500 chars) at the port boundary.
    expect(out.ref?.snippet).toContain("Vendor,Throughput");
  });

  test("emits mimeType from metadata.extra so renderers pick the file-type icon", async () => {
    insertDocument({
      id: "doc-drive-pdf",
      sourceId: "google-drive:self",
      title: "Budget Report.pdf",
      content: "Revenue projections for Q4.",
      sourceUrl: "https://drive.google.com/file/d/synth-gdrive-pdf/view",
      documentType: "file",
      mimeType: "application/pdf",
    });

    const port = createGatewayDocumentByUrlPort(db);
    const out = await port.lookup("https://drive.google.com/file/d/synth-gdrive-pdf/view");
    expect(out.ref?.documentId).toBe("doc-drive-pdf");
    expect(out.ref?.mimeType).toBe("application/pdf");
  });

  test("returns no ref when the URL is not in the corpus", async () => {
    const port = createGatewayDocumentByUrlPort(db);
    const out = await port.lookup("https://example.com/never-saved");
    expect(out.ref).toBeUndefined();
    expect(out.url).toBe("https://example.com/never-saved");
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("normalises the URL the same way ingest does (no-op for already-canonical URLs)", async () => {
    insertDocument({
      id: "doc-drive-2",
      sourceId: "google-drive:self",
      title: "Q3 OKRs",
      content: "Objective 1: ship.",
      sourceUrl: "https://drive.google.com/file/d/synth-gdrive-001/view",
    });
    // Same URL — already canonical — should match.
    const port = createGatewayDocumentByUrlPort(db);
    const out = await port.lookup("https://drive.google.com/file/d/synth-gdrive-001/view");
    expect(out.ref?.documentId).toBe("doc-drive-2");
  });

  test("on URL fan-out picks the document with the earliest source_created_at", async () => {
    const sharedUrl = "https://mail.google.com/mail/u/0/#all/thread-42";
    // Parent email ingested first; an attachment shares the same source_url.
    db.prepare(
      `INSERT INTO documents
         (id, provider_id, source_id, external_id, title, content, content_hash,
          metadata, source_url, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES
         ('doc-email-parent', 'test', 'gmail:self', 'ext-parent', 'Re: vendor follow-up',
          'parent body', 'hash-parent',
          '{"sourceUrl":"https://mail.google.com/mail/u/0/#all/thread-42","documentType":"email"}',
          ?, '2026-02-01T09:00:00Z', '2026-02-01T09:00:00Z', '2026-02-01T09:00:01Z', '2026-02-01T09:00:01Z'),
         ('doc-email-attachment', 'test', 'gmail:self', 'ext-attach', 'pricing.pdf',
          'attachment body', 'hash-attach',
          '{"sourceUrl":"https://mail.google.com/mail/u/0/#all/thread-42","documentType":"attachment"}',
          ?, '2026-02-01T09:00:30Z', '2026-02-01T09:00:30Z', '2026-02-01T09:00:31Z', '2026-02-01T09:00:31Z')`,
    ).run(sharedUrl, sharedUrl);

    const port = createGatewayDocumentByUrlPort(db);
    const out = await port.lookup(sharedUrl);
    expect(out.ref?.documentId).toBe("doc-email-parent");
    expect(out.ref?.documentType).toBe("email");
  });

  test("filters a URL collision before selecting the earliest document", async () => {
    const sharedUrl = "https://example.com/fictional-collision";
    insertDocument({
      id: "denied-earlier",
      sourceId: "mail:denied",
      title: "Denied",
      content: "DENIED_CANARY",
      sourceUrl: sharedUrl,
    });
    insertDocument({
      id: "allowed-later",
      sourceId: "mail:allowed",
      title: "Allowed",
      content: "safe",
      sourceUrl: sharedUrl,
    });
    const out = await createGatewayDocumentByUrlPort(db, undefined, authorization).lookup(
      sharedUrl,
    );
    expect(out.ref?.documentId).toBe("allowed-later");
    expect(JSON.stringify(out)).not.toContain("DENIED_CANARY");
  });

  test("returns the ref when metadata is empty (no sourceUrl / documentType)", async () => {
    // Schema enforces JSON-valid metadata via partial index — malformed JSON
    // can never reach the table. The realistic edge case is metadata = '{}'
    // (which is the column default), where the URL we matched on lives only
    // in the dedicated `source_url` column, not the JSON blob.
    db.prepare(
      `INSERT INTO documents
         (id, provider_id, source_id, external_id, title, content, content_hash,
          metadata, source_url, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES
         ('doc-empty-meta', 'test', 'notion-pages:self', 'ext-empty', 'Q4 OKRs',
          'body', 'hash-empty',
          '{}',
          'https://notion.so/page/abc', '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01')`,
    ).run();

    const port = createGatewayDocumentByUrlPort(db);
    const out = await port.lookup("https://notion.so/page/abc");
    expect(out.ref?.documentId).toBe("doc-empty-meta");
    // sourceUrl + documentType derive from metadata, which is empty — both
    // come back undefined while the ref itself is still produced.
    expect(out.ref?.url).toBeUndefined();
    expect(out.ref?.documentType).toBeUndefined();
    expect(out.ref?.title).toBe("Q4 OKRs");
    expect(out.ref?.sourceType).toBe("notion-pages");
  });
});
