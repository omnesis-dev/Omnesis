// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { buildCanonicalizerRegistry, normalizeUrl } from "@omnesis/core";
import { validateDocumentTemporalProjectionContracts } from "@omnesis/source-sdk";
import { TEMPORAL_KINDS, TEMPORAL_MODALITIES, TEMPORAL_STATUSES } from "@omnesis/types";
import googleProvider from "./index.js";

function specsFor(provider: typeof googleProvider) {
  return provider.sources
    .map((s) => s.urlCanonicalizer)
    .filter((s): s is NonNullable<typeof s> => Boolean(s));
}

const registry = buildCanonicalizerRegistry(specsFor(googleProvider));

test("Gmail opts only its explicit structured dates into document temporal projections", () => {
  const gmail = googleProvider.sources.find((source) => source.id === "gmail");
  expect(gmail?.documentTemporalProjections).toEqual([
    {
      slot: "scheduled",
      start: "scheduledAt",
      end: "endsAt",
      timeZone: "timeZone",
      kind: "event",
      modality: "asserted",
      status: "active",
    },
    {
      slot: "due",
      start: "dueAt",
      kind: "deadline",
      modality: "asserted",
      status: "active",
    },
  ]);
});

test("every Google document projection declaration satisfies the source-sdk contract", () => {
  for (const source of googleProvider.sources) {
    validateDocumentTemporalProjectionContracts(
      source.documentTemporalProjections,
      `provider google source '${source.id}'`,
    );
  }
});

test("Google document projections only ever name vocabulary values", () => {
  // Derived from the vocabulary arrays rather than restated here: a source
  // that invents a spelling next to itself must fail this, not redefine it.
  const vocabulary = {
    kind: TEMPORAL_KINDS,
    modality: TEMPORAL_MODALITIES,
    status: TEMPORAL_STATUSES,
  } as const;

  const declarations = googleProvider.sources.flatMap(
    (source) => source.documentTemporalProjections ?? [],
  );
  expect(declarations.length).toBeGreaterThan(0);

  for (const spec of declarations) {
    for (const [field, allowed] of Object.entries(vocabulary)) {
      const declared = spec[field as keyof typeof vocabulary];
      if (declared === undefined) continue;
      // A field is either a constant vocabulary value or a mapping off a
      // document field; both forms are checked against the same array.
      const values =
        typeof declared === "string"
          ? [declared]
          : [declared.default, ...Object.values(declared.map)];
      for (const value of values) {
        expect(allowed as readonly string[]).toContain(value);
      }
    }
  }
});

describe("gmail urlCanonicalizer — collapses every Gmail URL flavor onto #message/<id>", () => {
  const MSG = "19ce8e3c7ddedcdc";
  const canonical = `https://mail.google.com/mail/#message/${MSG}`;

  // Each entry is a real-world Gmail URL shape that should collapse to
  // `canonical`. The label/category cases used to fail because the segment
  // class was `[a-z0-9_-]+` — user-defined label names are routinely
  // mixed-case (e.g. "Promotions") and got rejected.
  const variants = [
    `https://mail.google.com/mail/#inbox/${MSG}`,
    `https://mail.google.com/mail/u/0/#inbox/${MSG}`,
    `https://mail.google.com/mail/u/1/#all/${MSG}`,
    `https://mail.google.com/mail/u/0/#search/budget/${MSG}`,
    `https://mail.google.com/mail/u/0/#label/promotions/${MSG}`,
    `https://mail.google.com/mail/u/0/#label/Promotions/${MSG}`,
    `https://mail.google.com/mail/u/0/#label/Work%20Stuff/${MSG}`,
    `https://mail.google.com/mail/u/0/#category/Promotions/${MSG}`,
    `https://mail.google.com/mail/u/0/#category/Updates/${MSG}`,
    // ?authuser=<email> account-pin (#463) — must collapse to the same key.
    `https://mail.google.com/mail/u/0/?authuser=user@gmail.com#all/${MSG}`,
    `https://mail.google.com/mail/u/0/?authuser=user%40gmail.com#all/${MSG}`,
    // Higher account indices — Gmail's URL slot supports any digit;
    // canonicalizer must accept them so multi-account users' eval URLs resolve.
    `https://mail.google.com/mail/u/2/#inbox/${MSG}`,
    `https://mail.google.com/mail/u/9/#all/${MSG}`,
    // URL with a trailing query string (compose flow, deep-link params).
    `https://mail.google.com/mail/u/0/#inbox/${MSG}?compose=new`,
  ];

  for (const v of variants) {
    test(v, () => {
      expect(normalizeUrl(v, registry)).toBe(canonical);
    });
  }
});

describe("google-drive urlCanonicalizer — collapses every Drive/Docs URL flavor onto file/d/<id>", () => {
  const FILE = "1xEHnbVVJfKpJ-Wfmc5nTtSQ-tEIEy85n";
  const canonical = `https://drive.google.com/file/d/${FILE}`;

  const variants = [
    `https://drive.google.com/file/d/${FILE}`,
    `https://drive.google.com/file/d/${FILE}/view`,
    `https://drive.google.com/file/d/${FILE}/view?usp=drivesdk`,
    `https://docs.google.com/document/d/${FILE}/edit`,
    `https://docs.google.com/document/d/${FILE}/edit?tab=t.0`,
    `https://docs.google.com/spreadsheets/d/${FILE}/edit`,
    `https://docs.google.com/presentation/d/${FILE}/edit`,
  ];

  for (const v of variants) {
    test(v, () => {
      expect(normalizeUrl(v, registry)).toBe(canonical);
    });
  }
});
