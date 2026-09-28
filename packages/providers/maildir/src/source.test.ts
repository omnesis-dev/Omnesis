// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveAttachmentConfig } from "@omnesis/core";
import { expectUnchangedUpstreamIsNoOp } from "@omnesis/source-sdk/testing";
import { MaildirSource } from "./source.js";
import {
  createMailbox,
  deliverMessage,
  maildirFileName,
  setThunderbirdStatus,
  storeThunderbirdMessage,
} from "./testing/maildir-writer.js";
import type { AttachmentExtractFn } from "@omnesis/core";
import type { DocumentInput } from "@omnesis/types";
import type { MaildirCursor, MaildirLimits } from "./source.js";
import type { FixtureMessage } from "./testing/maildir-writer.js";

const isRoot = process.getuid?.() === 0;
const SELF = { name: "Maya Reeves", address: "maya.reeves@example.com" };
const JAMIE = { name: "Jamie Lopez", address: "jamie.lopez@example.org" };
const DAVID = { name: "David Lin", address: "david.lin@example.io" };

let scratch: string;
let root: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "omnesis-maildir-source-"));
  root = join(scratch, "Mail");
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function message(overrides: Partial<FixtureMessage> & { messageId?: string } = {}): FixtureMessage {
  return {
    messageId: "welcome@example.org",
    from: JAMIE,
    to: [SELF],
    subject: "Welcome to the team",
    date: "2026-03-02T09:30:00Z",
    text: "Glad to have you. Sarah Mendez (sarah.mendez@example.net) runs onboarding.",
    ...overrides,
  };
}

const folder = (...segments: string[]) => createMailbox(join(root, ...segments));

interface CycleResult {
  emitted: DocumentInput[];
  present: string[] | undefined;
  pages: number;
  issues: unknown[];
}

/**
 * The gateway, as far as this source can tell: it commits each page's
 * documents and cursor, and a final page's snapshot removes what it omits.
 */
class FakeGateway {
  cursor: MaildirCursor | null = null;
  docs = new Map<string, DocumentInput>();

  async cycle(source: MaildirSource, maxPages = 200): Promise<CycleResult> {
    const emitted: DocumentInput[] = [];
    let pages = 0;
    for (;;) {
      const page = await source.sync(this.cursor);
      pages += 1;
      for (const doc of page.documents) this.docs.set(doc.externalId, doc);
      emitted.push(...page.documents);
      this.cursor = page.cursor;
      if (!page.hasMore) {
        if (page.presentExternalIds) {
          const present = new Set(page.presentExternalIds);
          for (const id of [...this.docs.keys()]) if (!present.has(id)) this.docs.delete(id);
        } else {
          expect(page.presentExternalIds).toBeUndefined();
        }
        return { emitted, present: page.presentExternalIds, pages, issues: page.issues ?? [] };
      }
      expect(page.presentExternalIds, "a snapshot only on the final page").toBeUndefined();
      if (pages >= maxPages) throw new Error("cycle did not settle");
    }
  }

  byTitle(title: string): DocumentInput {
    const doc = [...this.docs.values()].find((d) => d.title === title);
    if (!doc) throw new Error(`no document titled ${title}`);
    return doc;
  }
}

function makeSource(
  opts: {
    limits?: Partial<MaildirLimits>;
    dataCutoff?: string;
    extractAttachment?: AttachmentExtractFn;
    attachmentsEnabled?: boolean;
    exclude?: string[];
    indexPath?: string;
  } = {},
): MaildirSource {
  return new MaildirSource({
    sourceId: "maildir:fixture",
    providerId: "maildir:fixture",
    root,
    exclude: opts.exclude ?? [],
    indexPath: opts.indexPath ?? join(scratch, "index.sqlite"),
    dataCutoff: opts.dataCutoff,
    attachmentConfig: resolveAttachmentConfig(
      opts.attachmentsEnabled === false ? { extractAttachments: false } : undefined,
      { defaultEnabled: true },
    ),
    extractAttachment: opts.extractAttachment,
    limits: opts.limits,
  });
}

const fakeExtract: AttachmentExtractFn = (data) =>
  Promise.resolve({ text: new TextDecoder().decode(data), truncated: false });

describe("bootstrap", () => {
  test("emits one document per message with its people, folder and thread", async () => {
    const inbox = folder("INBOX");
    const sent = folder("Sent");
    deliverMessage(inbox, "1700000001.a.host", message(), { subdir: "new" });
    deliverMessage(
      sent,
      "1700000002.b.host",
      message({
        messageId: "reply@example.com",
        from: SELF,
        to: [JAMIE],
        cc: [DAVID],
        subject: "Re: Welcome to the team",
        date: "2026-03-02T10:00:00Z",
        text: "Thanks! Looping in David.",
        inReplyTo: "welcome@example.org",
        references: ["welcome@example.org"],
      }),
      { flags: "S" },
    );
    const gateway = new FakeGateway();
    const result = await gateway.cycle(makeSource());

    expect(result.emitted).toHaveLength(2);
    const welcome = gateway.byTitle("Welcome to the team");
    expect(welcome.content).toContain("**From:** Jamie Lopez <jamie.lopez@example.org>");
    expect(welcome.content).toContain("Glad to have you.");
    expect(welcome.sourceCreatedAt).toBe("2026-03-02T09:30:00.000Z");
    expect(welcome.metadata.documentType).toBe("email");
    expect(welcome.metadata.tags).toEqual(["INBOX"]);
    expect(welcome.metadata.relevanceScore).toBe(0.5);
    expect(welcome.metadata.people).toEqual([
      { role: "sender", name: "Jamie Lopez", emails: ["jamie.lopez@example.org"] },
      { role: "recipient", name: "Maya Reeves", emails: ["maya.reeves@example.com"] },
      { role: "mentioned", emails: ["sarah.mendez@example.net"] },
    ]);

    const reply = gateway.byTitle("Re: Welcome to the team");
    expect(reply.metadata.tags).toEqual(["SENT"]);
    expect(reply.metadata.relevanceScore).toBe(0.9);
    expect(reply.metadata.extra?.threadId).toBe(welcome.metadata.extra?.threadId);
    expect(reply.metadata.extra?.inReplyTo).toBe("welcome@example.org");
    expect(reply.metadata.people?.map((p) => p.role)).toEqual(["sender", "recipient", "recipient"]);

    expect(result.present?.sort()).toEqual([welcome.externalId, reply.externalId].sort());
    expect(result.issues).toEqual([]);
  });

  test("pages through scanning and emission, and snapshots only at the end", async () => {
    const inbox = folder("INBOX");
    for (let i = 0; i < 7; i++) {
      deliverMessage(
        inbox,
        `17000000${10 + i}.m${i}.host`,
        message({
          messageId: `m${i}@example.org`,
          subject: `Message ${i}`,
          date: `2026-03-0${i + 1}T08:00:00Z`,
        }),
      );
    }
    const gateway = new FakeGateway();
    const source = makeSource({ limits: { scanPageSize: 3, emitPageSize: 2 } });
    const result = await gateway.cycle(source);
    // Three scan pages, then four emission pages.
    expect(result.pages).toBe(7);
    expect(result.emitted.map((d) => d.title)).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((i) => `Message ${i}`),
    );
    expect(result.present).toHaveLength(7);
  });

  test("a message without a Date header takes its delivery time from the file name", async () => {
    deliverMessage(
      folder("INBOX"),
      "1767225600.a.host",
      "From: <jamie.lopez@example.org>\r\nSubject: Undated\r\n\r\nbody",
    );
    const gateway = new FakeGateway();
    await gateway.cycle(makeSource());
    expect(gateway.byTitle("Undated").sourceCreatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("Gmail's folders take the words Gmail uses, and All Mail tags nothing", async () => {
    const gmail = (name: string) => folder("[Gmail]", name);
    const welcome = message();
    deliverMessage(folder("INBOX"), "1.a.host", welcome, { flags: "S" });
    deliverMessage(gmail("All Mail"), "2.a.host", welcome, { flags: "S" });
    deliverMessage(gmail("Important"), "3.a.host", welcome, { flags: "S" });
    deliverMessage(gmail("Starred"), "4.a.host", welcome, { flags: "FS" });
    deliverMessage(folder("Work"), "5.a.host", welcome, { flags: "FS" });
    const sent = message({
      messageId: "sent@example.org",
      subject: "Sent note",
      from: SELF,
      to: [JAMIE],
    });
    deliverMessage(gmail("Messages envoyés"), "6.b.host", sent, { flags: "S" });
    const gateway = new FakeGateway();
    await gateway.cycle(makeSource());
    const doc = gateway.byTitle("Welcome to the team");
    expect(doc.metadata.tags).toEqual(["IMPORTANT", "INBOX", "STARRED", "Work"]);
    // Starred and important, as Gmail scores them.
    expect(doc.metadata.relevanceScore).toBe(0.8);
    expect(gateway.byTitle("Sent note").metadata.tags).toEqual(["SENT"]);
  });

  test("a plain-text stand-in gives way to the HTML, and markup in the text part is converted", async () => {
    const inbox = folder("INBOX");
    const article = "<p>" + "Quarterly product news with the full story. ".repeat(20) + "</p>";
    deliverMessage(
      inbox,
      "1.a.host",
      message({ subject: "Stand-in", text: "View this email in your browser.", html: article }),
    );
    deliverMessage(
      inbox,
      "2.b.host",
      message({
        messageId: "markup@example.org",
        subject: "Markup",
        text: "<html><body><div><p>Hello <b>there</b></p><br><span>from the team</span></div></body></html>",
      }),
    );
    const gateway = new FakeGateway();
    await gateway.cycle(makeSource());
    expect(gateway.byTitle("Stand-in").content).toContain("Quarterly product news");
    const markup = gateway.byTitle("Markup").content;
    expect(markup).toContain("Hello **there**");
    expect(markup).not.toContain("<div>");
  });

  test("entities a mailer left in the text are decoded and blank runs collapsed", async () => {
    deliverMessage(
      folder("INBOX"),
      "1.a.host",
      message({ text: "Tickets&nbsp;42 &#8217;n&#8217; pie &amp; tea\n\n\n\n\n\nBring a mug" }),
    );
    const gateway = new FakeGateway();
    await gateway.cycle(makeSource());
    const content = gateway.byTitle("Welcome to the team").content;
    expect(content).toContain("Tickets\u00a042 ’n’ pie & tea\n\nBring a mug");
  });

  test("a text part with a wrong charset gives way to a clean HTML part", async () => {
    const raw = [
      "From: <jamie.lopez@example.org>",
      "Subject: Charset",
      "Message-ID: <cs@example.org>",
      'Content-Type: multipart/alternative; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("Caf\xe9 cr\xe8me", "latin1").toString("base64"),
      "--b",
      "Content-Type: text/html; charset=iso-8859-1",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("<p>Caf\xe9 cr\xe8me</p>", "latin1").toString("base64"),
      "--b--",
      "",
    ].join("\r\n");
    deliverMessage(folder("INBOX"), "1.a.host", raw);
    const gateway = new FakeGateway();
    await gateway.cycle(makeSource());
    expect(gateway.byTitle("Charset").content).toContain("Café crème");
  });

  test("the header block and the body are separate paragraphs", async () => {
    deliverMessage(folder("INBOX"), "1.a.host", message());
    const gateway = new FakeGateway();
    await gateway.cycle(makeSource());
    // A line directly above "---" would render as a heading.
    expect(gateway.byTitle("Welcome to the team").content).toMatch(
      /\*\*Date:\*\* [^\n]+\n\n---\n\n/,
    );
  });

  test("HTML-only mail is converted to Markdown", async () => {
    deliverMessage(
      folder("INBOX"),
      "1.a.host",
      message({ text: "", html: "<p>Hello <strong>there</strong></p>" }),
    );
    const gateway = new FakeGateway();
    await gateway.cycle(makeSource());
    expect(gateway.byTitle("Welcome to the team").content).toContain("Hello **there**");
  });

  test("bulk and automated mail is marked and ranked down", async () => {
    deliverMessage(
      folder("INBOX"),
      "1.a.host",
      message({
        from: { address: "no-reply@example.net" },
        headers: { "List-Unsubscribe": "<https://example.net/unsubscribe>" },
      }),
    );
    const gateway = new FakeGateway();
    await gateway.cycle(makeSource());
    const doc = gateway.byTitle("Welcome to the team");
    expect(doc.metadata.bulkMail).toBe(true);
    expect(doc.metadata.automatedSender).toBe(true);
    expect(doc.metadata.relevanceScore).toBe(0.25);
  });
});

describe("incremental cycles", () => {
  test("an unchanged tree emits nothing and still names everything", async () => {
    deliverMessage(folder("INBOX"), "1.a.host", message());
    const gateway = new FakeGateway();
    const source = makeSource();
    await gateway.cycle(source);
    const again = await gateway.cycle(source);
    expect(again.emitted).toEqual([]);
    expect(again.present).toHaveLength(1);
  });

  test("a new message is the only one emitted", async () => {
    const inbox = folder("INBOX");
    deliverMessage(inbox, "1.a.host", message());
    const gateway = new FakeGateway();
    const source = makeSource();
    await gateway.cycle(source);
    deliverMessage(
      inbox,
      "2.b.host",
      message({ messageId: "second@example.org", subject: "Second" }),
    );
    const next = await gateway.cycle(source);
    expect(next.emitted.map((d) => d.title)).toEqual(["Second"]);
    expect(gateway.docs.size).toBe(2);
  });

  test("being read, or moving from new to cur, is not a change", async () => {
    const inbox = folder("INBOX");
    deliverMessage(inbox, "1.a.host", message(), { subdir: "new" });
    const gateway = new FakeGateway();
    const source = makeSource();
    await gateway.cycle(source);
    renameSync(
      join(inbox, "new", "1.a.host"),
      join(inbox, "cur", maildirFileName("1.a.host", "cur", "S")),
    );
    expect((await gateway.cycle(source)).emitted).toEqual([]);
  });

  test("starring and answering a message re-emit it with the new marks", async () => {
    const inbox = folder("INBOX");
    deliverMessage(inbox, "1.a.host", message(), { flags: "S" });
    const gateway = new FakeGateway();
    const source = makeSource();
    await gateway.cycle(source);
    renameSync(
      join(inbox, "cur", maildirFileName("1.a.host", "cur", "S")),
      join(inbox, "cur", maildirFileName("1.a.host", "cur", "FRS")),
    );
    const next = await gateway.cycle(source);
    expect(next.emitted).toHaveLength(1);
    const doc = gateway.byTitle("Welcome to the team");
    expect(doc.metadata.extra?.flagged).toBe(true);
    expect(doc.metadata.extra?.answered).toBe(true);
    expect(doc.metadata.relevanceScore).toBe(0.65);
  });

  test("a restarted source reuses its index and emits nothing new", async () => {
    deliverMessage(folder("INBOX"), "1.a.host", message());
    const gateway = new FakeGateway();
    const first = makeSource();
    await gateway.cycle(first);
    await first.dispose();
    const again = await gateway.cycle(makeSource());
    expect(again.emitted).toEqual([]);
    expect(again.present).toHaveLength(1);
  });
});

describe("copies in several folders", () => {
  test("are one document tagged with every folder, gone only with the last copy", async () => {
    const inbox = folder("INBOX");
    const all = folder("[Gmail]", "All Mail");
    const work = folder("Work");
    deliverMessage(inbox, "1.a.host", message(), { flags: "S" });
    deliverMessage(all, "2.a.host", message(), { flags: "S" });
    const gateway = new FakeGateway();
    const source = makeSource();
    const first = await gateway.cycle(source);
    expect(first.emitted).toHaveLength(1);
    const id = first.emitted[0]!.externalId;
    // All Mail holds every message of a Gmail mirror, so it tags nothing.
    expect(gateway.docs.get(id)!.metadata.tags).toEqual(["INBOX"]);

    // A label added in Gmail arrives as a copy in another folder.
    deliverMessage(work, "3.a.host", message(), { flags: "S" });
    const labelled = await gateway.cycle(source);
    expect(labelled.emitted.map((d) => d.externalId)).toEqual([id]);
    expect(gateway.docs.get(id)!.metadata.tags).toEqual(["INBOX", "Work"]);

    // Archiving removes the inbox copy; the message stays.
    rmSync(join(inbox, "cur", maildirFileName("1.a.host", "cur", "S")));
    rmSync(join(work, "cur", maildirFileName("3.a.host", "cur", "S")));
    const archived = await gateway.cycle(source);
    expect(archived.present).toEqual([id]);
    expect(gateway.docs.get(id)!.metadata.tags).toEqual([]);

    // Deleting the last copy removes it.
    rmSync(join(all, "cur", maildirFileName("2.a.host", "cur", "S")));
    const deleted = await gateway.cycle(source);
    expect(deleted.present).toEqual([]);
    expect(gateway.docs.size).toBe(0);
  });

  test("messages without a Message-ID stay apart, one per file", async () => {
    const raw =
      "From: <jamie.lopez@example.org>\r\nSubject: No id\r\nDate: Mon, 2 Mar 2026 09:30:00 +0000\r\n\r\nbody";
    deliverMessage(folder("INBOX"), "1.a.host", raw);
    deliverMessage(folder("Archive"), "1.a.host", raw);
    const gateway = new FakeGateway();
    const result = await gateway.cycle(makeSource());
    expect(result.emitted).toHaveLength(2);
    expect(new Set(result.emitted.map((d) => d.externalId)).size).toBe(2);
  });

  test("a message moved to trash is deleted", async () => {
    const inbox = folder("INBOX");
    const trash = folder("Trash");
    deliverMessage(inbox, "1.a.host", message(), { flags: "S" });
    const gateway = new FakeGateway();
    const source = makeSource();
    await gateway.cycle(source);
    renameSync(
      join(inbox, "cur", maildirFileName("1.a.host", "cur", "S")),
      join(trash, "cur", maildirFileName("1.a.host", "cur", "S")),
    );
    await gateway.cycle(source);
    expect(gateway.docs.size).toBe(0);
  });

  test("a message marked for deletion is deleted before it is expunged", async () => {
    const inbox = folder("INBOX");
    deliverMessage(inbox, "1.a.host", message(), { flags: "S" });
    const gateway = new FakeGateway();
    const source = makeSource();
    await gateway.cycle(source);
    renameSync(
      join(inbox, "cur", maildirFileName("1.a.host", "cur", "S")),
      join(inbox, "cur", maildirFileName("1.a.host", "cur", "ST")),
    );
    await gateway.cycle(source);
    expect(gateway.docs.size).toBe(0);
  });
});

describe("a Thunderbird profile's mail folder", () => {
  const READ = 0x0001;
  const REPLIED = 0x0002;
  const STARRED = 0x0004;
  const IMAP_DELETED = 0x0020_0000;
  const later = (seconds: number) => new Date(Date.UTC(2026, 3, 1, 12, 0, seconds));

  test("indexes each folder once, with its flags read from inside the file", async () => {
    storeThunderbirdMessage(join(root, "Inbox"), "1767225600.M1P1Q1.host", message(), {
      status: READ | STARRED,
    });
    storeThunderbirdMessage(
      join(root, "[Gmail].sbd", "All Mail"),
      "1767225600.M1P1Q2.host",
      message(),
      { status: READ | STARRED },
    );
    storeThunderbirdMessage(
      join(root, "Sent"),
      "1767225700.M1P1Q3.host",
      message({
        messageId: "reply@example.com",
        from: SELF,
        to: [JAMIE],
        subject: "Re: Welcome to the team",
        date: "2026-03-02T10:00:00Z",
        text: "Thanks!",
      }),
      { status: READ | REPLIED },
    );
    writeFileSync(join(root, "[Gmail].msf"), "");
    const gateway = new FakeGateway();
    await gateway.cycle(makeSource());
    expect(gateway.docs.size).toBe(2);
    const welcome = gateway.byTitle("Welcome to the team");
    expect(welcome.metadata.tags).toEqual(["INBOX", "STARRED"]);
    expect(welcome.metadata.extra?.flagged).toBe(true);
    const reply = gateway.byTitle("Re: Welcome to the team");
    expect(reply.metadata.tags).toEqual(["SENT"]);
    expect(reply.metadata.extra?.answered).toBe(true);
  });

  test("a flag Thunderbird rewrites in place re-emits that message alone", async () => {
    const inbox = join(root, "Inbox");
    const path = storeThunderbirdMessage(inbox, "1.eml-a", message(), { status: READ });
    storeThunderbirdMessage(
      inbox,
      "2.eml-b",
      message({ messageId: "second@example.org", subject: "Second" }),
      { status: READ },
    );
    const gateway = new FakeGateway();
    const source = makeSource();
    await gateway.cycle(source);
    expect((await gateway.cycle(source)).emitted).toEqual([]);

    setThunderbirdStatus(path, { status: READ | STARRED }, later(1));
    const starred = await gateway.cycle(source);
    expect(starred.emitted.map((d) => d.title)).toEqual(["Welcome to the team"]);
    expect(gateway.byTitle("Welcome to the team").metadata.extra?.flagged).toBe(true);
    expect(gateway.byTitle("Welcome to the team").metadata.tags).toContain("STARRED");

    setThunderbirdStatus(path, { status: READ }, later(2));
    expect((await gateway.cycle(source)).emitted).toHaveLength(1);
    expect(gateway.byTitle("Welcome to the team").metadata.extra?.flagged).toBeUndefined();
    expect(gateway.byTitle("Welcome to the team").metadata.tags).toEqual(["INBOX"]);
    expect(gateway.docs.size).toBe(2);
  });

  test("a message marked deleted, or removed, is deleted", async () => {
    const inbox = join(root, "Inbox");
    const marked = storeThunderbirdMessage(inbox, "1.a", message(), { status: READ });
    const removed = storeThunderbirdMessage(
      inbox,
      "2.b",
      message({ messageId: "second@example.org", subject: "Second" }),
    );
    storeThunderbirdMessage(
      inbox,
      "3.c",
      message({ messageId: "third@example.org", subject: "Third" }),
    );
    const gateway = new FakeGateway();
    const source = makeSource();
    await gateway.cycle(source);
    expect(gateway.docs.size).toBe(3);

    setThunderbirdStatus(marked, { status: READ, status2: IMAP_DELETED }, later(1));
    unlinkSync(removed);
    await gateway.cycle(source);
    expect([...gateway.docs.values()].map((d) => d.title)).toEqual(["Third"]);
  });

  test("a rewrite that leaves the size and modification time alone is still seen", async () => {
    const path = storeThunderbirdMessage(join(root, "Inbox"), "1.a", message(), { status: READ });
    const gateway = new FakeGateway();
    const source = makeSource();
    await gateway.cycle(source);
    const { mtime } = statSync(path);
    // A filesystem that keeps whole seconds: the rewrite lands in the same one.
    setThunderbirdStatus(path, { status: READ | STARRED }, mtime);
    expect((await gateway.cycle(source)).emitted).toHaveLength(1);
    expect(gateway.byTitle("Welcome to the team").metadata.extra?.flagged).toBe(true);
  });

  test.skipIf(isRoot)(
    "a changed file that will not open keeps its message until it reads again",
    async () => {
      const path = storeThunderbirdMessage(join(root, "Inbox"), "1.a", message(), {
        status: READ,
      });
      const gateway = new FakeGateway();
      const source = makeSource();
      await gateway.cycle(source);
      setThunderbirdStatus(path, { status: READ | STARRED }, later(1));
      chmodSync(path, 0o000);
      try {
        const blocked = await gateway.cycle(source);
        expect(blocked.present).toContain(gateway.byTitle("Welcome to the team").externalId);
        expect(gateway.docs.size).toBe(1);
      } finally {
        chmodSync(path, 0o644);
      }
      await gateway.cycle(source);
      expect(gateway.byTitle("Welcome to the team").metadata.extra?.flagged).toBe(true);
    },
  );

  test("a Maildir copied without its new directory keeps the flags in its file names", async () => {
    const copy = join(root, "Backup");
    storeThunderbirdMessage(copy, "0", "Subject: placeholder\r\n\r\nx");
    rmSync(join(copy, "cur", "0.eml"));
    deliverMessage(copy, "1.a.host", message(), { flags: "FS" });
    rmSync(join(copy, "new"), { recursive: true, force: true });
    deliverMessage(
      copy,
      "2.b.host",
      message({ messageId: "second@example.org", subject: "Second" }),
      { flags: "ST" },
    );
    rmSync(join(copy, "new"), { recursive: true, force: true });
    const gateway = new FakeGateway();
    await gateway.cycle(makeSource());
    expect([...gateway.docs.values()].map((d) => d.title)).toEqual(["Welcome to the team"]);
    expect(gateway.byTitle("Welcome to the team").metadata.extra?.flagged).toBe(true);
  });

  test("a restarted source reads nothing again", async () => {
    storeThunderbirdMessage(join(root, "Inbox"), "1.a", message(), { status: READ });
    const gateway = new FakeGateway();
    const first = makeSource();
    await gateway.cycle(first);
    await first.dispose();
    const again = await gateway.cycle(makeSource());
    expect(again.emitted).toEqual([]);
    expect(again.present).toHaveLength(1);
  });
});

describe("files that are not mail", () => {
  test("do not stop the cycle or poison the cursor", async () => {
    const inbox = folder("INBOX");
    deliverMessage(inbox, "1.a.host", message());
    deliverMessage(
      inbox,
      "2.junk.host",
      Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]).toString("latin1"),
    );
    const gateway = new FakeGateway();
    const source = makeSource();
    const first = await gateway.cycle(source);
    expect(first.emitted.map((d) => d.title)).toContain("Welcome to the team");
    expect(first.present).toHaveLength(first.emitted.length);
    const again = await gateway.cycle(source);
    expect(again.emitted).toEqual([]);
  });
});

describe("the gateway's cursor is the commit point", () => {
  test("a page the gateway never committed is emitted again", async () => {
    const inbox = folder("INBOX");
    deliverMessage(inbox, "1.a.host", message());
    deliverMessage(
      inbox,
      "2.b.host",
      message({ messageId: "second@example.org", subject: "Second", date: "2026-03-03T09:00:00Z" }),
    );
    const source = makeSource({ limits: { emitPageSize: 1 } });
    const scan = await source.sync(null);
    expect(scan.documents).toEqual([]);
    const committed = scan.cursor;
    // This page's result is lost: the gateway keeps the previous cursor.
    const lost = await source.sync(committed);
    expect(lost.documents.map((d) => d.title)).toEqual(["Welcome to the team"]);
    const retried = await source.sync(committed);
    expect(retried.documents.map((d) => d.title)).toEqual(["Welcome to the team"]);
    const last = await source.sync(retried.cursor);
    expect(last.documents.map((d) => d.title)).toEqual(["Second"]);
    expect(last.hasMore).toBe(false);
    expect(last.presentExternalIds).toHaveLength(2);
  });

  test.skipIf(isRoot)(
    "a re-emission the gateway never committed leaves the committed one in force",
    async () => {
      const inbox = folder("INBOX");
      deliverMessage(inbox, "1.a.host", message(), { flags: "S" });
      const gateway = new FakeGateway();
      const source = makeSource();
      await gateway.cycle(source);
      const committed = gateway.cursor;
      // Starred: the next page re-emits it, and that page is lost.
      const starred = join(inbox, "cur", maildirFileName("1.a.host", "cur", "FS"));
      renameSync(join(inbox, "cur", maildirFileName("1.a.host", "cur", "S")), starred);
      const lost = await source.sync(committed);
      expect(lost.documents).toHaveLength(1);
      // Before the retry the file stops opening, so it cannot be re-emitted.
      chmodSync(starred, 0o000);
      try {
        const retried = await source.sync(committed);
        expect(retried.documents).toEqual([]);
        // Still on disk, so still named, from what the gateway did commit.
        expect(retried.presentExternalIds).toEqual([...gateway.docs.keys()]);
      } finally {
        chmodSync(starred, 0o644);
      }
    },
  );

  test("a resync starts a new generation and re-emits every message", async () => {
    deliverMessage(folder("INBOX"), "1.a.host", message());
    const gateway = new FakeGateway();
    const source = makeSource();
    await gateway.cycle(source);
    source.onResync();
    gateway.cursor = null;
    gateway.docs.clear();
    const rebuilt = await gateway.cycle(source);
    expect(rebuilt.emitted).toHaveLength(1);
    expect(gateway.docs.size).toBe(1);
  });

  test("a page still being built when a resync lands records nothing", async () => {
    deliverMessage(
      folder("INBOX"),
      "1.a.host",
      message({
        attachments: [{ filename: "notes.pdf", mimeType: "application/pdf", content: "Agenda" }],
      }),
    );
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let extracting: () => void = () => {};
    const started = new Promise<void>((resolve) => (extracting = resolve));
    const slowExtract: AttachmentExtractFn = async (data) => {
      extracting();
      await gate;
      return { text: new TextDecoder().decode(data), truncated: false };
    };
    const source = makeSource({ extractAttachment: slowExtract });
    const scan = await source.sync(null);
    const late = source.sync(scan.cursor);
    await started; // The page is mid-build.
    source.onResync();
    release();
    await expect(late).rejects.toThrow(/restarted/);

    // The fresh run emits everything, including what the late page built.
    const gateway = new FakeGateway();
    const rebuilt = await gateway.cycle(source);
    expect(rebuilt.emitted.map((d) => d.metadata.documentType).sort()).toEqual([
      "attachment",
      "email",
    ]);
  });

  test("a second sync while one runs is refused", async () => {
    deliverMessage(folder("INBOX"), "1.a.host", message());
    const source = makeSource();
    const first = source.sync(null);
    await expect(source.sync(null)).rejects.toThrow(/already in progress/);
    await first;
  });
});

describe("data cutoff", () => {
  test("mail sent before the cutoff is neither emitted nor named", async () => {
    const inbox = folder("INBOX");
    deliverMessage(
      inbox,
      "1.a.host",
      message({ messageId: "old@example.org", subject: "Old", date: "2024-01-01T00:00:00Z" }),
    );
    deliverMessage(inbox, "2.b.host", message());
    const gateway = new FakeGateway();
    const result = await gateway.cycle(makeSource({ dataCutoff: "2025-01-01T00:00:00Z" }));
    expect(result.emitted.map((d) => d.title)).toEqual(["Welcome to the team"]);
    expect(result.present).toHaveLength(1);
  });
});

describe("attachments", () => {
  test("starring or archiving a message does not extract its attachments again", async () => {
    const inbox = folder("INBOX");
    const archive = folder("Archive");
    deliverMessage(
      inbox,
      "1.a.host",
      message({
        attachments: [{ filename: "scan.pdf", mimeType: "application/pdf", content: "Invoice" }],
      }),
      { flags: "S" },
    );
    let extractions = 0;
    const counting: AttachmentExtractFn = (data) => {
      extractions += 1;
      return Promise.resolve({ text: new TextDecoder().decode(data), truncated: false });
    };
    const gateway = new FakeGateway();
    const source = makeSource({ extractAttachment: counting });
    await gateway.cycle(source);
    expect(extractions).toBe(1);
    const child = [...gateway.docs.values()].find((d) => d.metadata.documentType === "attachment")!;

    renameSync(
      join(inbox, "cur", maildirFileName("1.a.host", "cur", "S")),
      join(archive, "cur", maildirFileName("1.a.host", "cur", "FS")),
    );
    const moved = await gateway.cycle(source);
    expect(extractions).toBe(1);
    expect(moved.emitted.map((d) => d.metadata.documentType)).toEqual(["email"]);
    const email = moved.emitted[0]!;
    expect(email.metadata.tags).toEqual(["Archive", "STARRED"]);
    expect(email.content).toContain("scan.pdf");
    // The child document stays, still named.
    expect(moved.present).toContain(child.externalId);
    expect(gateway.docs.has(child.externalId)).toBe(true);
  });

  const withAttachment = () =>
    message({
      attachments: [
        {
          filename: "agenda.pdf",
          mimeType: "application/pdf",
          content: "Quarterly planning agenda",
        },
      ],
    });

  test("an extracted attachment is a child document the snapshot names", async () => {
    deliverMessage(folder("INBOX"), "1.a.host", withAttachment());
    const gateway = new FakeGateway();
    const result = await gateway.cycle(makeSource({ extractAttachment: fakeExtract }));
    const child = result.emitted.find((d) => d.metadata.documentType === "attachment")!;
    expect(child.content).toContain("Quarterly planning agenda");
    expect(child.externalId.startsWith(`${result.emitted[0]!.externalId}/att/`)).toBe(true);
    expect(result.present).toContain(child.externalId);
    const email = result.emitted.find((d) => d.metadata.documentType === "email")!;
    expect(email.content).toContain("agenda.pdf");
  });

  test("turning extraction off re-emits the message and stops naming its child", async () => {
    deliverMessage(folder("INBOX"), "1.a.host", withAttachment());
    const gateway = new FakeGateway();
    await gateway.cycle(makeSource({ extractAttachment: fakeExtract }));
    expect(gateway.docs.size).toBe(2);
    const off = await gateway.cycle(
      makeSource({ extractAttachment: fakeExtract, attachmentsEnabled: false }),
    );
    expect(off.emitted).toHaveLength(1);
    expect(gateway.docs.size).toBe(1);
  });

  test("an attachment whose extraction failed is tried again later, and only it", async () => {
    deliverMessage(
      folder("INBOX"),
      "1.a.host",
      message({
        attachments: [
          { filename: "scan.png", mimeType: "image/png", content: "Receipt total" },
          { filename: "notes.pdf", mimeType: "application/pdf", content: "Meeting notes" },
        ],
      }),
    );
    let clock = Date.parse("2026-03-01T00:00:00Z");
    let ocrUp = false;
    const calls: string[] = [];
    const flaky: AttachmentExtractFn = (data, mime) => {
      calls.push(mime);
      if (mime === "image/png" && !ocrUp) return Promise.resolve(null);
      return Promise.resolve({ text: new TextDecoder().decode(data), truncated: false });
    };
    const source = new MaildirSource({
      sourceId: "maildir:fixture",
      providerId: "maildir:fixture",
      root,
      exclude: [],
      indexPath: join(scratch, "index.sqlite"),
      attachmentConfig: resolveAttachmentConfig(undefined, { defaultEnabled: true }),
      extractAttachment: flaky,
      now: () => clock,
    });
    const gateway = new FakeGateway();
    await gateway.cycle(source);
    expect(calls.sort()).toEqual(["application/pdf", "image/png"]);
    expect(
      [...gateway.docs.values()].filter((d) => d.metadata.documentType === "attachment"),
    ).toHaveLength(1);

    // Not due yet: nothing happens.
    calls.length = 0;
    clock += 30 * 60 * 1000;
    expect((await gateway.cycle(source)).emitted).toEqual([]);
    expect(calls).toEqual([]);

    // Due, and the backend is back: only the image is extracted again.
    ocrUp = true;
    clock += 31 * 60 * 1000;
    const retried = await gateway.cycle(source);
    expect(calls).toEqual(["image/png"]);
    expect(retried.emitted.map((d) => d.metadata.documentType).sort()).toEqual([
      "attachment",
      "email",
    ]);
    expect(
      [...gateway.docs.values()].filter((d) => d.metadata.documentType === "attachment"),
    ).toHaveLength(2);
    expect(retried.present).toHaveLength(3);

    // Settled: no further tries.
    calls.length = 0;
    clock += 48 * 60 * 60 * 1000;
    expect((await gateway.cycle(source)).emitted).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("an attachment that keeps failing is tried three more times, then left", async () => {
    deliverMessage(
      folder("INBOX"),
      "1.a.host",
      message({ attachments: [{ filename: "scan.png", mimeType: "image/png", content: "x" }] }),
    );
    let clock = Date.parse("2026-03-01T00:00:00Z");
    let calls = 0;
    const source = new MaildirSource({
      sourceId: "maildir:fixture",
      providerId: "maildir:fixture",
      root,
      exclude: [],
      indexPath: join(scratch, "index.sqlite"),
      attachmentConfig: resolveAttachmentConfig(undefined, { defaultEnabled: true }),
      extractAttachment: () => {
        calls += 1;
        return Promise.resolve(null);
      },
      now: () => clock,
    });
    const gateway = new FakeGateway();
    for (let cycle = 0; cycle < 8; cycle++) {
      await gateway.cycle(source);
      clock += 25 * 60 * 60 * 1000;
    }
    expect(calls).toBe(4);
  });

  test("an extraction failure is recorded on the message, not retried as a page failure", async () => {
    deliverMessage(folder("INBOX"), "1.a.host", withAttachment());
    const gateway = new FakeGateway();
    const failing: AttachmentExtractFn = () => Promise.reject(new Error("corrupt file"));
    const result = await gateway.cycle(makeSource({ extractAttachment: failing }));
    expect(result.emitted).toHaveLength(1);
    expect(result.emitted[0]!.metadata.extra?.attachments).toEqual([
      expect.objectContaining({
        filename: "agenda.pdf",
        extracted: false,
        reason: "extraction-failed",
      }),
    ]);
  });
});

describe("gaps withhold the snapshot", () => {
  test.skipIf(isRoot)(
    "an unreadable folder keeps its messages and withholds deletions",
    async () => {
      const inbox = folder("INBOX");
      const archive = folder("Archive");
      deliverMessage(inbox, "1.a.host", message(), { flags: "S" });
      deliverMessage(
        archive,
        "2.b.host",
        message({ messageId: "kept@example.org", subject: "Kept" }),
        { flags: "S" },
      );
      const gateway = new FakeGateway();
      const source = makeSource();
      await gateway.cycle(source);
      expect(gateway.docs.size).toBe(2);

      chmodSync(join(archive, "cur"), 0o000);
      try {
        rmSync(join(inbox, "cur", maildirFileName("1.a.host", "cur", "S")));
        const impaired = await gateway.cycle(source);
        expect(impaired.present).toBeUndefined();
        expect(impaired.issues).toHaveLength(1);
        expect(gateway.docs.size).toBe(2);
      } finally {
        chmodSync(join(archive, "cur"), 0o755);
      }
      const healed = await gateway.cycle(source);
      expect(healed.emitted).toEqual([]);
      expect([...gateway.docs.values()].map((d) => d.title)).toEqual(["Kept"]);
    },
  );

  test.skipIf(isRoot)(
    "an unreadable message file withholds nothing and is read once it opens",
    async () => {
      // The root is itself the inbox, the layout where a gap on one file once
      // stalled every folder.
      createMailbox(root);
      deliverMessage(root, "1.a.host", message(), { flags: "S" });
      const locked = deliverMessage(
        root,
        "2.b.host",
        message({ messageId: "locked@example.org", subject: "Locked" }),
        { flags: "S" },
      );
      deliverMessage(
        folder("Archive"),
        "3.c.host",
        message({ messageId: "c@example.org", subject: "Archived" }),
      );
      chmodSync(locked, 0o000);
      const gateway = new FakeGateway();
      const source = makeSource();
      try {
        const first = await gateway.cycle(source);
        expect(first.emitted.map((d) => d.title).sort()).toEqual([
          "Archived",
          "Welcome to the team",
        ]);
        expect(first.present).toHaveLength(2);
        expect(first.issues).toEqual([]);
      } finally {
        chmodSync(locked, 0o644);
      }
      const healed = await gateway.cycle(source);
      expect(healed.emitted.map((d) => d.title)).toEqual(["Locked"]);
      expect(gateway.docs.size).toBe(3);
    },
  );

  test.skipIf(isRoot)(
    "a folder that stays unreadable keeps its messages cycle after cycle",
    async () => {
      const inbox = folder("INBOX");
      const archive = folder("Archive");
      deliverMessage(inbox, "1.a.host", message(), { flags: "S" });
      deliverMessage(
        archive,
        "2.b.host",
        message({ messageId: "kept@example.org", subject: "Kept" }),
        {
          flags: "S",
        },
      );
      const gateway = new FakeGateway();
      const source = makeSource();
      await gateway.cycle(source);
      chmodSync(join(archive, "cur"), 0o000);
      try {
        for (let cycle = 0; cycle < 3; cycle++) {
          const impaired = await gateway.cycle(source);
          expect(impaired.emitted).toEqual([]);
          expect(impaired.present).toBeUndefined();
          expect(gateway.docs.size).toBe(2);
        }
      } finally {
        chmodSync(join(archive, "cur"), 0o755);
      }
      const healed = await gateway.cycle(source);
      expect(healed.emitted).toEqual([]);
      expect(healed.present).toHaveLength(2);
    },
  );

  test.skipIf(isRoot)(
    "a message whose only new copy cannot be read yet is not taken for deleted",
    async () => {
      const inbox = folder("INBOX");
      const archive = folder("Archive");
      deliverMessage(inbox, "1.a.host", message(), { flags: "S" });
      const gateway = new FakeGateway();
      const source = makeSource();
      await gateway.cycle(source);
      // Archived: the copy reappears in another folder under a new name,
      // and that file will not open this cycle.
      rmSync(join(inbox, "cur", maildirFileName("1.a.host", "cur", "S")));
      const moved = deliverMessage(archive, "2.b.host", message(), { flags: "S" });
      chmodSync(moved, 0o000);
      try {
        const impaired = await gateway.cycle(source);
        expect(impaired.present).toBeUndefined();
        expect(gateway.docs.size).toBe(1);
      } finally {
        chmodSync(moved, 0o644);
      }
      const healed = await gateway.cycle(source);
      expect(healed.present).toHaveLength(1);
      expect(gateway.byTitle("Welcome to the team").metadata.tags).toEqual(["Archive"]);
    },
  );

  test.skipIf(isRoot)(
    "an unreadable root inbox withholds deletions without holding back other folders",
    async () => {
      createMailbox(root);
      const archive = folder("Archive");
      deliverMessage(root, "1.a.host", message(), { flags: "S" });
      deliverMessage(
        archive,
        "2.b.host",
        message({ messageId: "gone@example.org", subject: "Gone" }),
        {
          flags: "S",
        },
      );
      const gateway = new FakeGateway();
      const source = makeSource();
      await gateway.cycle(source);
      chmodSync(join(root, "cur"), 0o000);
      try {
        rmSync(join(archive, "cur", maildirFileName("2.b.host", "cur", "S")));
        deliverMessage(
          archive,
          "3.c.host",
          message({ messageId: "new@example.org", subject: "New" }),
        );
        const impaired = await gateway.cycle(source);
        // The root's gap covers the root alone: Archive still ingests.
        expect(impaired.emitted.map((d) => d.title)).toEqual(["New"]);
        expect(impaired.present).toBeUndefined();
        expect(gateway.docs.size).toBe(3);
      } finally {
        chmodSync(join(root, "cur"), 0o755);
      }
      await gateway.cycle(source);
      expect([...gateway.docs.values()].map((d) => d.title).sort()).toEqual([
        "New",
        "Welcome to the team",
      ]);
    },
  );

  test("a root that vanished is an error, never an empty snapshot", async () => {
    deliverMessage(folder("INBOX"), "1.a.host", message());
    const gateway = new FakeGateway();
    const source = makeSource();
    await gateway.cycle(source);
    rmSync(root, { recursive: true, force: true });
    await expect(gateway.cycle(source)).rejects.toThrow(/not there/);
    expect(gateway.docs.size).toBe(1);
  });
});

test("the snapshot size guard fires", async () => {
  const inbox = folder("INBOX");
  deliverMessage(inbox, "1.a.host", message());
  deliverMessage(inbox, "2.b.host", message({ messageId: "b@example.org" }));
  const gateway = new FakeGateway();
  await expect(gateway.cycle(makeSource({ limits: { maxPresentIds: 1 } }))).rejects.toThrow(
    /more than 1 documents/,
  );
});

test("two sources over two trees share nothing", async () => {
  deliverMessage(folder("INBOX"), "1.a.host", message());
  const otherRoot = join(scratch, "Other");
  deliverMessage(
    createMailbox(join(otherRoot, "INBOX")),
    "9.z.host",
    message({ messageId: "other@example.org", subject: "Other" }),
  );
  const one = new FakeGateway();
  const two = new FakeGateway();
  await one.cycle(makeSource({ indexPath: join(scratch, "one.sqlite") }));
  await two.cycle(
    new MaildirSource({
      sourceId: "maildir:other",
      providerId: "maildir:other",
      root: otherRoot,
      exclude: [],
      indexPath: join(scratch, "two.sqlite"),
      attachmentConfig: resolveAttachmentConfig(undefined, { defaultEnabled: true }),
    }),
  );
  expect([...one.docs.values()].map((d) => d.title)).toEqual(["Welcome to the team"]);
  expect([...two.docs.values()].map((d) => d.title)).toEqual(["Other"]);
});

test("unchanged upstream is a no-op", async () => {
  const inbox = folder("INBOX");
  for (let i = 0; i < 5; i++) {
    deliverMessage(
      inbox,
      `${i}.m.host`,
      message({ messageId: `m${i}@example.org`, subject: `Message ${i}` }),
    );
  }
  const source = makeSource({ limits: { scanPageSize: 2, emitPageSize: 2 } });
  await expectUnchangedUpstreamIsNoOp({
    initialCursor: null,
    settleSteps: 6,
    primaryKey: () => ["externalId"],
    async step(cursor) {
      const page = await source.sync(cursor as MaildirCursor | null);
      return {
        cursor: page.cursor,
        hasMore: page.hasMore,
        records: page.documents.map((doc) => ({
          table: "documents",
          row: { externalId: doc.externalId, contentHash: doc.contentHash, metadata: doc.metadata },
        })),
      };
    },
  });
});
