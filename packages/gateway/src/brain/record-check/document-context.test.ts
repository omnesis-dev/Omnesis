// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { documentRecordContext } from "./document-context.js";

test("bounds substantive context without treating length or duplicate sources as value", () => {
  const body = "🧭".repeat(6_000);
  const atoms = Array.from({ length: 10 }, (_, i) => ({
    docId: i < 2 ? "subject" : "another-source",
    quote: "🧭".repeat(400),
  }));
  const context = documentRecordContext("subject", body, atoms);
  expect(context.subject_truncated).toBe(true);
  expect(context.subject_characters).toBe(body.length);
  expect(context.subject_text.length).toBeLessThan(8_100);
  expect(context.evidence).toHaveLength(9);
  expect(context.evidence_truncated).toBe(true);
  expect(context.evidence[0]).toMatchObject({ source: 0, is_subject: true });
  expect(context.evidence[1]).toMatchObject({ source: 0, is_subject: true });
  expect(context.evidence[2]).toMatchObject({ source: 1, is_subject: false });
  expect(context.evidence.every((item) => item.quote.length <= 500)).toBe(true);
  expect(context.subject_text.isWellFormed()).toBe(true);
  expect(context.evidence.every((item) => item.quote.isWellFormed())).toBe(true);
  expect(JSON.stringify(context)).not.toContain("another-source");
});

test("keeps a short source in full, including boilerplate the model must discount", () => {
  const source = "The workshop agenda changed.\nImage: https://example.org/banner.png\nFooter";
  expect(
    documentRecordContext("source", source, [
      { docId: "source", quote: "The workshop agenda changed." },
    ]),
  ).toMatchObject({ subject_text: source, subject_truncated: false, evidence_truncated: false });
});
