// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, vi } from "vitest";
import { addsToMessage, messageDate } from "./gmail-message.js";
import { createMockGmail, createGmailSource, makeGmailMessage } from "./testing/mock-google.js";
import type { DocumentInput } from "@omnesis/types";

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

describe("Gmail message normalization", () => {
  let gmail: ReturnType<typeof createMockGmail>;

  beforeEach(() => {
    gmail = createMockGmail();
  });

  async function normalize(message: Record<string, unknown>): Promise<DocumentInput> {
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: message.id }] } }),
    );
    gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: message }));
    const result = await createGmailSource(gmail).sync(null);
    return result.documents[0]!;
  }

  describe("date", () => {
    test("an imported message is dated by its Date header, not by when Gmail received it", async () => {
      const doc = await normalize(
        makeGmailMessage("m-1", {
          internalDate: String(Date.UTC(2012, 5, 1)),
          date: "Tue, 03 Mar 2009 10:15:00 +0100",
        }),
      );
      expect(doc.sourceCreatedAt).toBe("2009-03-03T09:15:00.000Z");
    });

    test("falls back to internalDate when the header is missing, unparseable or implausible", () => {
      const internal = String(Date.UTC(2024, 0, 2));
      const now = Date.UTC(2026, 0, 1);
      expect(messageDate(undefined, internal, now)).toBe("2024-01-02T00:00:00.000Z");
      expect(messageDate("not a date", internal, now)).toBe("2024-01-02T00:00:00.000Z");
      expect(messageDate("Thu, 01 Jan 1970 00:00:00 +0000", internal, now)).toBe(
        "2024-01-02T00:00:00.000Z",
      );
      expect(messageDate("Mon, 01 Jan 2035 00:00:00 +0000", internal, now)).toBe(
        "2024-01-02T00:00:00.000Z",
      );
    });
  });

  test("uses the receiving server's stamp when the header and internalDate are both implausible", () => {
    const now = Date.UTC(2026, 0, 1);
    const received = "from mx.example.com by mail.example.org; Tue, 03 Mar 2015 10:15:00 +0000";
    expect(messageDate("Sun, 12 Jan 2612 17:58:50 GMT", "-1000", now, received)).toBe(
      "2015-03-03T10:15:00.000Z",
    );
    expect(messageDate("Sun, 12 Jan 2612 17:58:50 GMT", "0", now, received)).toBe(
      "2015-03-03T10:15:00.000Z",
    );
    expect(messageDate("Sun, 12 Jan 2612 17:58:50 GMT", "-1000", now, "no date here")).toBe(
      "1969-12-31T23:59:59.000Z",
    );
  });

  describe("body", () => {
    test("a text part is read in the charset it declares", async () => {
      const doc = await normalize(
        makeGmailMessage("m-2", {
          payload: {
            headers: [
              { name: "Subject", value: "Compte rendu" },
              { name: "From", value: "maya.reeves@example.com" },
              { name: "To", value: "jamie.lopez@example.org" },
              { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
            ],
            mimeType: "text/plain",
            body: { data: b64(Buffer.from("Réunion déplacée à jeudi.", "latin1")) },
          },
        }),
      );
      expect(doc.content).toContain("Réunion déplacée à jeudi.");
      expect(doc.content).not.toContain("�");
    });

    test("a part declaring ISO-8859-1 in its own headers is decoded with it", async () => {
      const doc = await normalize(
        makeGmailMessage("m-3", {
          payload: {
            headers: [
              { name: "Subject", value: "Menu" },
              { name: "From", value: "maya.reeves@example.com" },
              { name: "To", value: "jamie.lopez@example.org" },
              { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
            ],
            mimeType: "multipart/alternative",
            parts: [
              {
                mimeType: "text/plain",
                headers: [{ name: "Content-Type", value: "text/plain; charset=ISO-8859-1" }],
                body: { data: b64(Buffer.from("Crème brûlée ce soir", "latin1")) },
              },
            ],
          },
        }),
      );
      expect(doc.content).toContain("Crème brûlée ce soir");
    });

    test("text split into several parts around an inline image keeps every part", async () => {
      const headers = [
        { name: "Subject", value: "Trip notes" },
        { name: "From", value: "maya.reeves@example.com" },
        { name: "To", value: "jamie.lopez@example.org" },
        { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
      ];
      const doc = await normalize(
        makeGmailMessage("m-10", {
          payload: {
            headers,
            mimeType: "multipart/mixed",
            parts: [
              {
                mimeType: "text/html",
                body: { data: b64("<p>Day one: we reached the lake.</p>") },
              },
              {
                mimeType: "image/png",
                filename: "lake.png",
                body: { attachmentId: "att-1", size: 40_000 },
              },
              { mimeType: "text/html", body: { data: b64("<p>Day two: the ridge walk.</p>") } },
            ],
          },
        }),
      );
      expect(doc.content).toContain("Day one: we reached the lake.");
      expect(doc.content).toContain("Day two: the ridge walk.");
    });

    test("a body Gmail returns by attachment id is fetched and read", async () => {
      gmail.users.messages.attachments.get = vi.fn((params: { id: string }) =>
        Promise.resolve({
          data: {
            data: params.id === "body-1" ? b64("<p>The full itinerary for the week.</p>") : "",
          },
        }),
      );
      const doc = await normalize(
        makeGmailMessage("m-12", {
          payload: {
            headers: [
              { name: "Subject", value: "Itinerary" },
              { name: "From", value: "maya.reeves@example.com" },
              { name: "To", value: "jamie.lopez@example.org" },
              { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
            ],
            mimeType: "multipart/alternative",
            parts: [{ mimeType: "text/html", body: { attachmentId: "body-1", size: 120_000 } }],
          },
        }),
      );
      expect(doc.content).toContain("The full itinerary for the week.");
    });

    test("a short first HTML part does not hide the one that carries the message", async () => {
      // The sender's own text carries a replacement character, in the markup
      // plain part and in the long HTML part alike; the short one has none.
      const article = Array.from(
        { length: 40 },
        (_, i) => `<p>Paragraph ${i} of the quarterly review \uFFFD see notes.</p>`,
      ).join("");
      const doc = await normalize(
        makeGmailMessage("m-11", {
          payload: {
            headers: [
              { name: "Subject", value: "Quarterly review" },
              { name: "From", value: "news@example.com" },
              { name: "To", value: "jamie.lopez@example.org" },
              { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
            ],
            mimeType: "multipart/parallel",
            parts: [
              { mimeType: "text/html", body: { data: b64("<p>Sent from our office.</p>") } },
              {
                mimeType: "multipart/alternative",
                parts: [
                  {
                    mimeType: "text/plain",
                    body: { data: b64(`<html><body>${article}</body></html>`) },
                  },
                  {
                    mimeType: "text/html",
                    body: { data: b64(`<html><body>${article}</body></html>`) },
                  },
                ],
              },
            ],
          },
        }),
      );
      expect(doc.content).toContain("Paragraph 0 of the quarterly review");
      expect(doc.content).toContain("Paragraph 39 of the quarterly review");
      expect(doc.content).not.toContain("<p>");
    });

    test("a 'view in browser' plain part gives way to the HTML that carries the message", async () => {
      const paragraphs = Array.from(
        { length: 60 },
        (_, i) => `<p>Section ${i} of the garden club newsletter.</p>`,
      ).join("");
      const doc = await normalize(
        makeGmailMessage("m-4", {
          payload: {
            headers: [
              { name: "Subject", value: "Newsletter" },
              { name: "From", value: "news@example.com" },
              { name: "To", value: "jamie.lopez@example.org" },
              { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
            ],
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64("View this email in your browser") } },
              {
                mimeType: "text/html",
                body: { data: b64(`<html><body>${paragraphs}</body></html>`) },
              },
            ],
          },
        }),
      );
      expect(doc.content).toContain("Section 59 of the garden club newsletter.");
    });

    test("the date line is followed by a blank line, so it never renders as a heading", async () => {
      const doc = await normalize(makeGmailMessage("m-5"));
      expect(doc.content).toMatch(/\*\*Date:\*\* [^\n]+\n\n---\n\nHello world/);
    });
  });

  describe("people", () => {
    test("Bcc recipients on sent mail are recipients", async () => {
      const doc = await normalize(
        makeGmailMessage("m-6", {
          labelIds: ["SENT"],
          from: "maya.reeves@example.com",
          to: "jamie.lopez@example.org",
          extraHeaders: [{ name: "Bcc", value: "Accounts <david.lin@example.net>" }],
        }),
      );
      const recipients = (doc.metadata.people ?? [])
        .filter((p) => p.role === "recipient")
        .flatMap((p) => p.emails ?? []);
      expect(recipients).toEqual(["jamie.lopez@example.org", "david.lin@example.net"]);
      expect(doc.content).toContain("**Bcc:** Accounts <david.lin@example.net>");
    });

    test("an automated sender links to a person but never creates one", async () => {
      const doc = await normalize(makeGmailMessage("m-7", { from: "notifications@example.com" }));
      const sender = doc.metadata.people?.find((p) => p.role === "sender");
      expect(sender?.emails).toEqual(["notifications@example.com"]);
      expect(sender?.allowPersonCreation).toBe(false);
      expect(doc.metadata.automatedSender).toBe(true);
    });
  });
});

describe("addsToMessage", () => {
  const message = "Thanks for the call. maya, the design studio, +44 7700 900123, maya@example.com";

  test("text the message already carries adds nothing", () => {
    expect(addsToMessage("the design studio", message)).toBe(false);
    expect(addsToMessage("MAYA@EXAMPLE.COM", message)).toBe(false);
    expect(addsToMessage("", message)).toBe(false);
  });

  test("a phone number is the same number however its prefix is written", () => {
    expect(addsToMessage("Tel 07700 900123", message)).toBe(false);
    expect(addsToMessage("Tel (0)7700-900-123", message)).toBe(false);
    expect(addsToMessage("Tel +44 7700 900456", message)).toBe(true);
  });

  test("a date or a short code is not taken for a phone number", () => {
    expect(addsToMessage("2024-01-15", message)).toBe(false);
  });

  test("an email address the message lacks is new", () => {
    expect(addsToMessage("desk@example.org", message)).toBe(true);
  });

  test("a few words the message never uses are new, one or two are not", () => {
    expect(addsToMessage("Award winner", message)).toBe(false);
    expect(addsToMessage("registered office above the old bakery", message)).toBe(true);
  });
});
