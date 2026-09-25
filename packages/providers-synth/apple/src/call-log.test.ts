// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { loadCallLog, mapCallLog } from "./fixtures.js";

describe("synthetic Apple call-log documents", () => {
  const entry = loadCallLog()[0]!;

  test("uses only the configured Apple account as the self participant", () => {
    const document = mapCallLog(entry, {
      sourceId: SourceId("apple-call-log:john.smith@icloud.example"),
      providerId: ProviderId("apple:john.smith@icloud.example"),
    });
    const people = document.metadata.people ?? [];

    expect(people).toContainEqual({
      role: "participant",
      emails: ["john.smith@icloud.example"],
    });
    expect(people.some((person) => person.emails?.includes("john.smith@example.com"))).toBe(false);
    expect(people.some((person) => person.emails?.includes("john.smith@acme.example"))).toBe(false);
  });

  test("omits self identity when the source account is not an email", () => {
    const document = mapCallLog(entry, {
      sourceId: SourceId("apple-call-log:local"),
      providerId: ProviderId("apple:local"),
    });
    const people = document.metadata.people ?? [];

    expect(
      people.some((person) => person.emails?.some((email) => email.startsWith("john.smith"))),
    ).toBe(false);
  });
});
