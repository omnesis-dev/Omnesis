// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure-function tests for the projection helpers in events.ts —
 * `extractPeopleFromMetadata` + `computeChangedFields`. The full
 * round-trip (DocumentInput → emitted event with before/after) is
 * exercised end-to-end via the integration tests in EventService.
 */

import { describe, expect, test } from "vitest";
import {
  computeChangedFields,
  extractPeopleFromMetadata,
  type DocumentProjection,
} from "./events.js";

function projection(overrides: Partial<DocumentProjection> = {}): DocumentProjection {
  return {
    id: "doc-1",
    providerId: "google",
    sourceId: "gmail:me@example.com",
    externalId: "ext-1",
    documentType: "email",
    title: "Subject",
    contentHash: "h1",
    metadata: {},
    sourceCreatedAt: "2026-01-01T00:00:00Z",
    sourceUpdatedAt: "2026-01-01T00:00:00Z",
    people: [],
    ...overrides,
  };
}

describe("extractPeopleFromMetadata", () => {
  test("a person named only by a platform identifier survives the projection", () => {
    // Every GitHub and Strava participant is named this way, and so is any
    // messaging contact whose number was never shared. Dropping the field left
    // them out of the projection entirely, and so out of anything reading it.
    const [entry] = extractPeopleFromMetadata({
      people: [{ role: "author", lids: ["github:maya-reeves"] }],
    });
    expect(entry?.lids).toEqual(["github:maya-reeves"]);
    expect(entry?.role).toBe("author");
  });

  test("a non-string identifier is dropped rather than carried through", () => {
    const [entry] = extractPeopleFromMetadata({
      people: [{ role: "author", lids: ["strava-athlete:1", 7, null] }],
    });
    expect(entry?.lids).toEqual(["strava-athlete:1"]);
  });

  test("returns empty array when metadata is undefined", () => {
    expect(extractPeopleFromMetadata(undefined)).toEqual([]);
  });

  test("returns empty array when metadata.people is missing", () => {
    expect(extractPeopleFromMetadata({})).toEqual([]);
  });

  test("returns empty array when metadata.people is not an array", () => {
    expect(extractPeopleFromMetadata({ people: "not an array" } as never)).toEqual([]);
  });

  test("extracts role + name + emails", () => {
    const out = extractPeopleFromMetadata({
      people: [
        { role: "sender", name: "Alice", emails: ["alice@example.com"] },
        { role: "recipient", emails: ["bob@example.com"] },
      ],
    });
    expect(out).toEqual([
      { role: "sender", personId: null, name: "Alice", emails: ["alice@example.com"] },
      { role: "recipient", personId: null, emails: ["bob@example.com"] },
    ]);
  });

  test("personId is always null at projection time (resolution is async)", () => {
    const out = extractPeopleFromMetadata({
      people: [{ role: "sender", personId: "p-123" }],
    });
    expect(out[0].personId).toBe(null);
  });

  test("skips entries without a string `role`", () => {
    const out = extractPeopleFromMetadata({
      people: [
        { role: "sender", name: "OK" },
        { role: 42 }, // bad role type
        null,
        { name: "no role" },
      ] as never,
    });
    expect(out.length).toBe(1);
    expect(out[0].role).toBe("sender");
  });

  test("filters non-string emails", () => {
    const out = extractPeopleFromMetadata({
      people: [{ role: "sender", emails: ["a@b.com", 42, null, "c@d.com"] }] as never,
    });
    expect(out[0].emails).toEqual(["a@b.com", "c@d.com"]);
  });

  test("drops emails entirely if all are non-string", () => {
    const out = extractPeopleFromMetadata({
      people: [{ role: "sender", emails: [42, null] }] as never,
    });
    expect(out[0].emails).toBeUndefined();
  });

  test("extracts phones when present", () => {
    const out = extractPeopleFromMetadata({
      people: [{ role: "participant", name: "Q", phones: ["+447700900123"] }],
    });
    expect(out).toEqual([
      { role: "participant", personId: null, name: "Q", phones: ["+447700900123"] },
    ]);
  });

  test("filters non-string phones and drops the field if none remain", () => {
    const out = extractPeopleFromMetadata({
      people: [
        { role: "participant", phones: ["+447700900123", 42, null] },
        { role: "mentioned", phones: [42, null] },
      ] as never,
    });
    expect(out[0].phones).toEqual(["+447700900123"]);
    expect(out[1].phones).toBeUndefined();
  });
});

describe("computeChangedFields", () => {
  test("returns empty array when before is null (insert)", () => {
    expect(computeChangedFields(null, projection())).toEqual([]);
  });

  test("identical before/after → empty changedFields", () => {
    const a = projection({ metadata: { tags: ["UNREAD"], documentType: "email" } });
    const b = projection({ metadata: { tags: ["UNREAD"], documentType: "email" } });
    expect(computeChangedFields(a, b)).toEqual([]);
  });

  test("title change is detected", () => {
    const a = projection({ title: "Old" });
    const b = projection({ title: "New" });
    expect(computeChangedFields(a, b)).toContain("title");
  });

  test("contentHash change is detected", () => {
    const a = projection({ contentHash: "h1" });
    const b = projection({ contentHash: "h2" });
    expect(computeChangedFields(a, b)).toContain("contentHash");
  });

  test("documentType change is detected", () => {
    const a = projection({ documentType: "email" });
    const b = projection({ documentType: "event" });
    expect(computeChangedFields(a, b)).toContain("documentType");
  });

  test("sourceUpdatedAt change is detected", () => {
    const a = projection({ sourceUpdatedAt: "2026-01-01T00:00:00Z" });
    const b = projection({ sourceUpdatedAt: "2026-01-02T00:00:00Z" });
    expect(computeChangedFields(a, b)).toContain("sourceUpdatedAt");
  });

  test("metadata.tags change is reported separately from metadata", () => {
    const a = projection({ metadata: { tags: ["UNREAD"] } });
    const b = projection({ metadata: { tags: [] } });
    const fields = computeChangedFields(a, b);
    expect(fields).toContain("metadata.tags");
    expect(fields).toContain("metadata");
  });

  test("metadata change without tag change reports metadata but not metadata.tags", () => {
    const a = projection({
      metadata: { tags: ["UNREAD"], extra: { threadId: "t1" } },
    });
    const b = projection({
      metadata: { tags: ["UNREAD"], extra: { threadId: "t2" } },
    });
    const fields = computeChangedFields(a, b);
    expect(fields).toContain("metadata");
    expect(fields).not.toContain("metadata.tags");
  });

  test("people change is detected", () => {
    const a = projection({ people: [] });
    const b = projection({
      people: [{ role: "sender", personId: null, name: "Alice" }],
    });
    expect(computeChangedFields(a, b)).toContain("people");
  });

  test("multiple changes all surface", () => {
    const a = projection({ title: "A", metadata: { tags: ["UNREAD"] } });
    const b = projection({ title: "B", metadata: { tags: ["IMPORTANT"] } });
    const fields = computeChangedFields(a, b);
    expect(fields).toEqual(expect.arrayContaining(["title", "metadata.tags", "metadata"]));
  });
});
