// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The document-event profile is the document half of the source contract that
 * `AnalyticsTableSchema` already covers for rows. It reaches the subscription
 * compiler's prompt, so every invariant is enforced at the source boundary:
 * a declaration the compiler cannot act on truthfully would surface to the
 * operator as approvable prose describing a watch that can never match.
 */

import { describe, expect, it } from "vitest";
import { defineProvider, defineSource, defineStructuredSource } from "./define-source.js";
import { validateDocumentEventProfile } from "./structured-source.js";
import type { AnalyticsTableSchema, DocumentEventProfile } from "./structured-source.js";

const VALID: DocumentEventProfile = {
  documentTypes: ["email", "attachment"],
  personRoles: ["sender", "recipient"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description: "Labels the mailbox applies to a message.",
      canonicalValues: ["receipts", "travel"],
      valueAliases: { receipts: ["receipt", "invoices"] },
    },
    {
      path: "extra.threadId",
      type: "string",
      description: "Opaque conversation identifier shared by a thread.",
    },
  ],
};

/** Deep clone so a mutation in one case can't leak into the next. */
function profile(patch: Partial<DocumentEventProfile> = {}): DocumentEventProfile {
  return { ...(JSON.parse(JSON.stringify(VALID)) as DocumentEventProfile), ...patch };
}

const analyticsSchema: AnalyticsTableSchema = {
  tableName: "example_rows",
  displayName: "Example rows",
  description: "Rows a structured source emits.",
  columns: [{ name: "id", type: "VARCHAR", description: "Row id" }],
  primaryKey: ["id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["id"], keyColumns: ["id"] },
};

describe("validateDocumentEventProfile", () => {
  it("accepts a fully populated declaration", () => {
    expect(() => validateDocumentEventProfile(profile(), "test")).not.toThrow();
  });

  it("accepts an absent declaration", () => {
    expect(() => validateDocumentEventProfile(undefined, "test")).not.toThrow();
  });

  it("rejects an alias for a value the field never declares", () => {
    const bad = profile({
      metadataFields: [
        {
          path: "tags",
          type: "string-array",
          description: "Labels the mailbox applies to a message.",
          canonicalValues: ["receipts"],
          valueAliases: { travel: ["trips"] },
        },
      ],
    });
    expect(() => validateDocumentEventProfile(bad, "test")).toThrow(/aliases 'travel'/);
  });

  it("rejects the same metadata path declared twice", () => {
    const bad = profile({
      metadataFields: [
        { path: "tags", type: "string-array", description: "First." },
        { path: "tags", type: "string", description: "Second." },
      ],
    });
    expect(() => validateDocumentEventProfile(bad, "test")).toThrow(/declares 'tags' twice/);
  });

  it("rejects a path that is not a dotted metadata path", () => {
    const bad = profile({
      metadataFields: [{ path: "extra..threadId", type: "string", description: "Broken." }],
    });
    expect(() => validateDocumentEventProfile(bad, "test")).toThrow(/dotted path under metadata/);
  });

  it("rejects a path longer than subscription compilation can carry", () => {
    // Compilation parses the resolved path back out of a compiled plan under
    // its own bound, so a longer declaration would compile plans that never
    // materialize.
    const bad = profile({
      metadataFields: [
        { path: `extra.${"segment".repeat(20)}`, type: "string", description: "Too deep." },
      ],
    });
    expect(() => validateDocumentEventProfile(bad, "test")).toThrow(/longer than 120 characters/);
  });

  it("rejects a field with a blank description", () => {
    const bad = profile({
      metadataFields: [{ path: "tags", type: "string-array", description: "   " }],
    });
    expect(() => validateDocumentEventProfile(bad, "test")).toThrow(/needs a description/);
  });

  it("rejects a field declaring both allowedValues and canonicalValues", () => {
    const bad = profile({
      metadataFields: [
        {
          path: "status",
          type: "string",
          description: "Delivery state.",
          allowedValues: ["sent"],
          canonicalValues: ["draft"],
        },
      ],
    });
    expect(() => validateDocumentEventProfile(bad, "test")).toThrow(
      /both allowedValues and canonicalValues/,
    );
  });

  it("rejects a document type outside the declared shape", () => {
    expect(() =>
      validateDocumentEventProfile(profile({ documentTypes: ["Email"] }), "test"),
    ).toThrow(/documentType 'Email' must match/);
  });

  it("rejects a person role outside the closed vocabulary", () => {
    const bad = profile({ personRoles: ["sender", "cc"] as DocumentEventProfile["personRoles"] });
    expect(() => validateDocumentEventProfile(bad, "test")).toThrow(/unsupported personRole 'cc'/);
  });

  it("names the context in the error so the offending source is identifiable", () => {
    const bad = profile({ documentTypes: ["Email"] });
    expect(() => validateDocumentEventProfile(bad, "defineSource('mailbox')")).toThrow(
      /defineSource\('mailbox'\): documentEventProfile/,
    );
  });
});

describe("definition-time enforcement", () => {
  const create = async () => ({
    sync: async () => ({ documents: [], cursor: {}, hasMore: false }),
  });

  it("defineSource rejects a malformed profile", () => {
    expect(() =>
      defineSource({
        id: "mailbox",
        name: "Mailbox",
        description: "Example",
        authType: "none",
        documentEventProfile: profile({ documentTypes: ["Email"] }),
        create,
      }),
    ).toThrow(/defineSource\('mailbox'\): documentEventProfile/);
  });

  it("defineSource carries a valid profile onto the definition", () => {
    const def = defineSource({
      id: "mailbox",
      name: "Mailbox",
      description: "Example",
      authType: "none",
      documentEventProfile: profile(),
      create,
    });
    expect(def.documentEventProfile).toEqual(VALID);
  });

  it("defineProvider rejects a malformed profile on one source entry", () => {
    expect(() =>
      defineProvider({
        provider: { id: "workspace", name: "Workspace" },
        authType: "none",
        createContext: async () => ({}),
        sources: [
          {
            id: "workspace-mail",
            name: "Workspace inbox",
            description: "Example",
            documentEventProfile: profile({ documentTypes: ["Email"] }),
            create,
          },
        ],
      }),
    ).toThrow(/defineProvider source 'workspace-mail': documentEventProfile/);
  });

  it("defineStructuredSource rejects a malformed profile", () => {
    expect(() =>
      defineStructuredSource({
        id: "ledger",
        name: "Ledger",
        description: "Example",
        authType: "none",
        analyticsSchemas: [analyticsSchema],
        documentEventProfile: profile({ documentTypes: ["Email"] }),
        create: async () => ({
          syncStructured: async () => ({
            records: [],
            tableName: "example_rows",
            cursor: {},
            hasMore: false,
          }),
          analyticsSchemas: [analyticsSchema],
        }),
      }),
    ).toThrow(/defineStructuredSource\('ledger'\): documentEventProfile/);
  });
});
