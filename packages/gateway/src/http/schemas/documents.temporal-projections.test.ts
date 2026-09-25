// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { validateDocumentTemporalProjectionContracts } from "@omnesis/core";
import { SCOPE_WRITE_ALL } from "@omnesis/types";
import { BadRequestError } from "../errors.js";
import { DocumentService, type DocumentServiceDeps } from "../services/DocumentService.js";
import { upsertWithCursorBody } from "./documents.js";
import type { DocumentTemporalProjectionSpec } from "@omnesis/source-sdk";

function body(documentTemporalProjections: unknown) {
  return {
    providerId: "example-provider",
    sourceId: "example-source:account",
    documents: [],
    documentTemporalProjections,
    hasMore: false,
    cursor: {},
  };
}

describe("upsertWithCursorBody document temporal projections", () => {
  test("accepts the closed source-owned declaration", () => {
    const result = upsertWithCursorBody.parse(
      body([
        {
          slot: "planned",
          start: "scheduledAt",
          end: "endsAt",
          kind: "event",
          modality: "scheduled",
          timeZone: "timeZone",
          sourceUpdatedAt: "$semanticTime",
          correlationKeys: ["scheduledAt"],
        },
        {
          slot: "due",
          start: "dueAt",
          kind: "deadline",
          modality: "asserted",
          status: "active",
        },
      ]),
    );
    expect(result.documentTemporalProjections).toHaveLength(2);
  });

  test("accepts a mapped vocabulary field", () => {
    const result = upsertWithCursorBody.parse(
      body([
        {
          slot: "planned",
          start: "$semanticTime",
          kind: { from: "scheduledAt", map: { booking: "appointment" }, default: "event" },
          modality: "scheduled",
        },
      ]),
    );
    expect(result.documentTemporalProjections?.[0]?.kind).toEqual({
      from: "scheduledAt",
      map: { booking: "appointment" },
      default: "event",
    });
  });

  test("accepts a mapped source lifecycle status", () => {
    const result = upsertWithCursorBody.parse(
      body([
        {
          slot: "due",
          start: "dueAt",
          kind: "deadline",
          modality: "asserted",
          status: {
            from: "status",
            map: { open: "active", completed: "completed", canceled: "cancelled" },
            default: "active",
          },
        },
      ]),
    );
    expect(result.documentTemporalProjections?.[0]?.status).toEqual({
      from: "status",
      map: { open: "active", completed: "completed", canceled: "cancelled" },
      default: "active",
    });
  });

  test("canonicalizes a retired kind spelling from an older client", () => {
    const result = upsertWithCursorBody.parse(
      body([
        {
          slot: "planned",
          start: "scheduledAt",
          kind: "calendar_event",
          modality: "scheduled",
        },
      ]),
    );
    expect(result.documentTemporalProjections?.[0]?.kind).toBe("appointment");
  });

  test("rejects duplicate slots", () => {
    expect(() =>
      upsertWithCursorBody.parse(
        body([
          {
            slot: "due",
            start: "dueAt",
            kind: "deadline",
            modality: "asserted",
          },
          {
            slot: "due",
            start: "scheduledAt",
            kind: "event",
            modality: "scheduled",
          },
        ]),
      ),
    ).toThrow(/Duplicate document temporal projection slot/);
  });

  test("rejects arbitrary metadata paths and vocabularies", () => {
    expect(() =>
      upsertWithCursorBody.parse(
        body([
          {
            slot: "custom",
            start: "extra.when",
            kind: "custom",
            modality: "guessed",
          },
        ]),
      ),
    ).toThrow();
  });

  // Documents carry no typed boolean a projection may read, so the two boolean
  // gates of the projection spec have no document-plane spelling at all.
  test.each(["allDay", "eligibility"])("rejects the boolean gate '%s'", (field) => {
    expect(() =>
      upsertWithCursorBody.parse(
        body([
          {
            slot: "planned",
            start: "scheduledAt",
            kind: "event",
            modality: "scheduled",
            [field]: "$semanticTime",
          },
        ]),
      ),
    ).toThrow();
  });

  // `timeZone` and `status` are projectable facts, but neither carries a date
  // in any of the three positions whose values must resolve to instants.
  test.each(["timeZone", "status"])(
    "rejects the dateless field '%s' in date positions",
    (value) => {
      for (const field of ["start", "end", "sourceUpdatedAt"]) {
        expect(() =>
          upsertWithCursorBody.parse(
            body([
              {
                slot: "planned",
                start: field === "start" ? value : "scheduledAt",
                kind: "event",
                modality: "scheduled",
                ...(field === "start" ? {} : { [field]: value }),
              },
            ]),
          ),
        ).toThrow();
      }
    },
  );

  test("every declaration the wire shape accepts also satisfies the contract validator", () => {
    const parsed = upsertWithCursorBody.parse(
      body([
        {
          slot: "planned",
          start: "scheduledAt",
          end: "endsAt",
          label: "$semanticTime",
          kind: { from: "scheduledAt", map: { booking: "appointment" }, default: "event" },
          modality: "scheduled",
          status: "active",
          timeZone: "timeZone",
          sourceUpdatedAt: "$semanticTime",
          correlationKeys: ["dueAt"],
        },
      ]),
    );
    expect(() =>
      validateDocumentTemporalProjectionContracts(
        parsed.documentTemporalProjections as DocumentTemporalProjectionSpec[],
        "test",
      ),
    ).not.toThrow();
  });
});

describe("upsertWithCursor projection-contract gate", () => {
  function service(): DocumentService {
    // The gate runs before any dependency is touched, so the stubs only have to
    // satisfy the constructor.
    return new DocumentService({
      db: {} as unknown as DocumentServiceDeps["db"],
      writeGate: {} as unknown as DocumentServiceDeps["writeGate"],
      events: {} as unknown as DocumentServiceDeps["events"],
      sourceDataRemoval: {} as unknown as DocumentServiceDeps["sourceDataRemoval"],
    });
  }

  test("rejects a spec the wire shape accepts but the contract forbids", async () => {
    // An empty `map` is structurally a mapped field and passes the wire shape,
    // but it maps nothing — the contract wants a constant instead.
    const emptyMap = {
      slot: "planned",
      start: "scheduledAt",
      kind: { from: "scheduledAt", map: {}, default: "event" },
      modality: "scheduled",
    };
    const parsed = upsertWithCursorBody.parse(body([emptyMap]));
    expect(parsed.documentTemporalProjections).toHaveLength(1);

    const error = await service()
      .upsertWithCursor({
        callerScopes: [SCOPE_WRITE_ALL],
        body: {
          providerId: parsed.providerId,
          sourceId: parsed.sourceId,
          documentTemporalProjections:
            parsed.documentTemporalProjections as DocumentTemporalProjectionSpec[],
          hasMore: false,
          cursor: {},
        },
      })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(BadRequestError);
    expect((error as BadRequestError).status).toBe(400);
    expect((error as BadRequestError).message).toMatch(/map must not be empty/);
  });
});
