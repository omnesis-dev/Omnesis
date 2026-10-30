// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pins every entry of the declared `documentEventProfile` to a document the
 * normalizer really produces: a declared field or role nobody emits compiles
 * a watch condition that can never fire.
 */

import { describe, expect, it } from "vitest";
import { validateDocumentEventProfile } from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import { DAVID, JAMIE, MAYA, msg } from "./fake-discord.js";
import { normalizeChannelDay } from "./normalizer.js";
import discordProvider from "./index.js";
import type { DocumentMetadataFieldSpec } from "@omnesis/source-sdk";
import type { PersonRole } from "@omnesis/types";

const profile = discordProvider.sources[0].documentEventProfile!;

const doc = normalizeChannelDay(
  {
    id: "30",
    guildId: "1",
    guildName: "Northstar Labs",
    name: "Q4 budget review",
    kind: "forum-post",
    parentName: "planning",
  },
  "2026-03-08",
  [
    msg("30", MAYA, "2026-03-08T09:00:00.000Z", `ping <@${DAVID.id}>`, { mentions: [DAVID] }),
    msg("30", JAMIE, "2026-03-08T09:03:00.000Z", "on it"),
  ],
  { providerId: ProviderId("discord:9"), sourceId: SourceId("discord:9"), selfUserId: MAYA.id },
)!;

function readPath(path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], doc.metadata);
}

const TYPE_CHECKS: Record<DocumentMetadataFieldSpec["type"], (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  "string-array": (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
};

describe("discord documentEventProfile", () => {
  it("is a valid profile", () => {
    expect(() => validateDocumentEventProfile(profile, "provider-discord")).not.toThrow();
  });

  it("declares exactly the document types and roles the normalizer emits", () => {
    expect(new Set(profile.documentTypes)).toEqual(new Set([doc.metadata.documentType]));
    const roles = new Set<PersonRole>(doc.metadata.people!.map((p) => p.role));
    expect(new Set(profile.personRoles)).toEqual(roles);
  });

  it("declares only fields a real document carries, with the declared type", () => {
    for (const field of profile.metadataFields ?? []) {
      const value = readPath(field.path);
      expect(value, field.path).toBeDefined();
      expect(TYPE_CHECKS[field.type](value), `${field.path} is ${field.type}`).toBe(true);
      if (field.allowedValues) expect(field.allowedValues, field.path).toContain(value);
    }
  });
});
