// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fakeSourceHost } from "@omnesis/source-sdk/testing";
import { ProviderId, SourceId } from "@omnesis/types";
import { createMailbox, deliverMessage } from "./testing/maildir-writer.js";
import definition, { maildirDocumentEventProfile } from "./index.js";
import type { MaildirCursor } from "./source.js";
import type { DocumentInput } from "@omnesis/types";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "omnesis-maildir-descriptor-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("descriptor", () => {
  test("is an experimental local source with a complete icon", () => {
    expect(definition.id).toBe("maildir");
    expect(definition.authType).toBe("local");
    expect(definition.experimental).toBe(true);
    expect(definition.unitName).toBe("emails");
    const icon = definition.icon!;
    expect(icon.sfSymbol).toBeTruthy();
    expect(icon.color).toMatch(/^#[0-9A-F]{6}$/i);
    expect(icon.bgColor).toMatch(/^#[0-9A-F]{6}$/i);
    expect(icon.imageDataUri).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  test("names an account by its folder and keeps the id of an already configured one", () => {
    const mail = join(scratch, "Mail");
    mkdirSync(mail);
    symlinkSync(mail, join(scratch, "alias"));
    const id = definition.resolveAccountId!({ path: mail }, []);
    expect(id).toMatch(/^Mail-[0-9a-f]{16}$/);
    expect(definition.resolveAccountId!({ path: join(scratch, "alias") }, [])).toBe(id);
    expect(
      definition.resolveAccountId!({ path: join(scratch, "alias") }, [
        { accountId: "configured-earlier", params: { path: mail } },
      ]),
    ).toBe("configured-earlier");
  });
});

/** Run a created instance to the end of one cycle, as the collector does. */
async function drain(
  instance: Awaited<ReturnType<NonNullable<typeof definition.create>>>,
): Promise<{ documents: DocumentInput[]; present?: string[] }> {
  let cursor: MaildirCursor | null = null;
  const documents: DocumentInput[] = [];
  for (let page = 0; page < 50; page++) {
    const result = await instance.sync(cursor);
    documents.push(...result.documents);
    cursor = result.cursor;
    if (!result.hasMore) return { documents, present: result.presentExternalIds };
  }
  throw new Error("did not settle");
}

describe("create", () => {
  test("keeps its index in the account's state directory and watches the tree", async () => {
    const root = join(scratch, "Mail");
    deliverMessage(
      createMailbox(join(root, "INBOX")),
      "1.a.host",
      "Subject: Hello\r\nMessage-ID: <h@example.org>\r\n\r\nbody",
    );
    const stateDir = join(scratch, "state");
    mkdirSync(stateDir);
    const instance = await definition.create!({
      accountId: "Mail-0",
      sourceId: SourceId("maildir:Mail-0"),
      providerId: ProviderId("maildir:Mail-0"),
      config: { path: root, exclude: [] },
      host: fakeSourceHost({ stateDir }),
    });
    expect(instance.watchPaths).toEqual([root]);
    expect(instance.watchDirectoryPaths).toEqual([root]);
    const { documents, present } = await drain(instance);
    expect(documents.map((d) => d.title)).toEqual(["Hello"]);
    expect(present).toHaveLength(1);
    await instance.dispose?.();

    // A second instance over the same state directory finds its index.
    const again = await definition.create!({
      accountId: "Mail-0",
      sourceId: SourceId("maildir:Mail-0"),
      providerId: ProviderId("maildir:Mail-0"),
      config: { path: root, exclude: [] },
      host: fakeSourceHost({ stateDir }),
    });
    const first = await again.sync(null);
    expect(first.documents.map((d) => d.title)).toEqual(["Hello"]);
    await again.dispose?.();
  });

  test("refuses to start without a folder", async () => {
    await expect(
      definition.create!({
        accountId: "x",
        sourceId: SourceId("maildir:x"),
        providerId: ProviderId("maildir:x"),
        config: { path: "", exclude: [] },
      }),
    ).rejects.toThrow(/needs the folder/);
  });
});

describe("document event profile", () => {
  test("declares exactly what the normalizer writes through the real sync path", async () => {
    const root = join(scratch, "Mail");
    deliverMessage(
      createMailbox(join(root, "INBOX")),
      "1.a.host",
      [
        "From: no-reply@example.net",
        "To: Maya Reeves <maya.reeves@example.com>",
        "Subject: Receipt",
        "Message-ID: <r@example.org>",
        "List-Unsubscribe: <https://example.net/u>",
        "Content-Type: multipart/mixed; boundary=b",
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "Questions? Write to help@example.net",
        "--b",
        'Content-Type: application/pdf; name="r.pdf"',
        'Content-Disposition: attachment; filename="r.pdf"',
        "",
        "receipt text",
        "--b--",
        "",
      ].join("\r\n"),
      { flags: "FRS" },
    );
    const instance = await definition.create!({
      accountId: "p",
      sourceId: SourceId("maildir:p"),
      providerId: ProviderId("maildir:p"),
      config: { path: root, exclude: [] },
      host: fakeSourceHost({
        stateDir: scratch,
        extractAttachment: (data) =>
          Promise.resolve({ text: new TextDecoder().decode(data), truncated: false }),
      }),
    });
    const { documents } = await drain(instance);
    await instance.dispose?.();

    const types = [...new Set(documents.map((d) => d.metadata.documentType))].sort();
    expect(types).toEqual([...(maildirDocumentEventProfile.documentTypes ?? [])].sort());
    const roles = new Set(documents.flatMap((d) => d.metadata.people?.map((p) => p.role) ?? []));
    for (const role of roles) expect(maildirDocumentEventProfile.personRoles).toContain(role);
    expect([...roles].sort()).toEqual([...(maildirDocumentEventProfile.personRoles ?? [])].sort());

    const email = documents.find((d) => d.metadata.documentType === "email")!;
    const read = (path: string): unknown =>
      path
        .split(".")
        .reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], email.metadata);
    for (const field of maildirDocumentEventProfile.metadataFields ?? []) {
      expect(read(field.path), `${field.path} is declared but not written`).toBeDefined();
    }
    expect(email.metadata.tags).toEqual(["INBOX"]);
  });
});
