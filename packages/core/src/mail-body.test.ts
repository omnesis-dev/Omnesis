// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { charsetOfContentType, chooseMailBody, decodeMailText, tidyMailBody } from "./mail-body.js";

describe("decodeMailText", () => {
  test("valid UTF-8 is read as UTF-8 whatever the part declares", () => {
    expect(decodeMailText(Buffer.from("Café crème", "utf8"), "iso-8859-1")).toBe("Café crème");
  });

  test("Latin-1 bytes are read in the declared charset", () => {
    expect(decodeMailText(Buffer.from("Voilà le détail", "latin1"), "ISO-8859-1")).toBe(
      "Voilà le détail",
    );
  });

  test("bytes that claim UTF-8 but are not read as windows-1252", () => {
    const bytes = Buffer.concat([
      Buffer.from("Prix ", "latin1"),
      Buffer.from([0x96]),
      Buffer.from(" 20 EUR"),
    ]);
    expect(decodeMailText(bytes, "utf-8")).toBe("Prix – 20 EUR");
  });

  test("an unknown or missing charset falls back to windows-1252", () => {
    expect(decodeMailText(Buffer.from("Réunion", "latin1"), "x-unknown")).toBe("Réunion");
    expect(decodeMailText(Buffer.from("Réunion", "latin1"))).toBe("Réunion");
  });

  test("charsetOfContentType reads a quoted or bare parameter", () => {
    expect(charsetOfContentType('text/plain; charset="ISO-8859-1"')).toBe("ISO-8859-1");
    expect(charsetOfContentType("text/html;charset=utf-8")).toBe("utf-8");
    expect(charsetOfContentType("text/plain")).toBeUndefined();
  });
});

describe("tidyMailBody", () => {
  test("decodes entities and collapses blank runs", () => {
    expect(tidyMailBody("Hello&nbsp;there &amp; you&#8217;re\n\n\n\n\nNext")).toBe(
      "Hello\u00a0there & you’re\n\nNext",
    );
  });
});

describe("chooseMailBody", () => {
  const article = Array.from(
    { length: 120 },
    (_, i) => `Paragraph ${i} about the quarterly garden plan.`,
  ).join("\n");

  test("keeps a plain part that carries the message", () => {
    const text = "Hello team,\n\nThe budget review moved to Thursday.\n\nJamie";
    expect(chooseMailBody({ text, html: `<p>${text}</p>` })).toBe(text);
  });

  test("reads the HTML when the plain part is a stand-in", () => {
    const body = chooseMailBody({
      text: "View this email in your browser",
      html: `<html><body>${article
        .split("\n")
        .map((l) => `<p>${l}</p>`)
        .join("")}</body></html>`,
    });
    expect(body).toContain("Paragraph 119 about the quarterly garden plan.");
  });

  test("reads the HTML when the plain part is an abridged version", () => {
    const abridged = article.split("\n").slice(0, 30).join("\n") + "\nRead more online.";
    const html = `<div>${article
      .split("\n")
      .map((l) => `<p>${l}</p>`)
      .join("")}</div>`;
    const body = chooseMailBody({ text: abridged, html });
    expect(body).toContain("Paragraph 119");
  });

  test("link targets do not make HTML outweigh a complete plain part", () => {
    const text = article;
    const html = article
      .split("\n")
      .map((l) => `<p><a href="https://example.com/${"tracking/".repeat(20)}">${l}</a></p>`)
      .join("");
    expect(chooseMailBody({ text, html })).toBe(text);
  });

  test("converts markup sent in the plain part", () => {
    const text = "<html><body><div><p>Hello</p><p>World</p><br><span>x</span></div></body></html>";
    expect(chooseMailBody({ text })).toContain("Hello");
    expect(chooseMailBody({ text })).not.toContain("<p>");
  });

  test("prefers the HTML when the plain part decodes into more replacement characters", () => {
    const body = chooseMailBody({
      text: "R\uFFFDsum\uFFFD of the week",
      html: "<p>Résumé of the week</p>",
    });
    expect(body).toBe("Résumé of the week");
  });

  test("an HTML-only message is converted in full", () => {
    const html = `<div>${article
      .split("\n")
      .map((l) => `<p>${l}</p>`)
      .join("")}</div>`;
    const body = chooseMailBody({ html });
    expect(body).toContain("Paragraph 0 about");
    expect(body).toContain("Paragraph 119 about");
  });
});
