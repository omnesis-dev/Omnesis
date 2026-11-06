// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { SourceType, ProviderType } from "@omnesis/types";
import { isPushOrAnalyticsOnly, serializeDescriptor } from "./source-descriptor.js";
import type { SourceScopes } from "@omnesis/types";
import type { SourceDescriptor } from "./source-descriptor.js";
import type { AnalyticsTableSchema, DocumentEventProfile } from "./structured-source.js";

const schema: AnalyticsTableSchema = {
  tableName: "metrics",
  displayName: "Metrics",
  description: "Example analytics table",
  columns: [{ name: "id", type: "VARCHAR", description: "Row id" }],
  primaryKey: ["id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["id"], keyColumns: ["id"] },
};

describe("isPushOrAnalyticsOnly", () => {
  it("is true for a push-based source", () => {
    expect(isPushOrAnalyticsOnly({ pushBased: true })).toBe(true);
  });

  it("is true for an analytics-only source (declares analytics schemas)", () => {
    expect(isPushOrAnalyticsOnly({ analyticsSchemas: [schema] })).toBe(true);
  });

  it("is true when both signals are present", () => {
    expect(isPushOrAnalyticsOnly({ pushBased: true, analyticsSchemas: [schema] })).toBe(true);
  });

  it("is false for a plain pull-based document source", () => {
    expect(isPushOrAnalyticsOnly({})).toBe(false);
    expect(isPushOrAnalyticsOnly({ pushBased: false })).toBe(false);
    expect(isPushOrAnalyticsOnly({ pushBased: false, analyticsSchemas: [] })).toBe(false);
  });
});

const documentEventProfile: DocumentEventProfile = {
  documentTypes: ["email"],
  personRoles: ["sender", "recipient"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description: "Labels the mailbox applies to a message.",
      canonicalValues: ["receipts"],
      valueAliases: { receipts: ["receipt"] },
    },
  ],
};

function descriptor(overrides: Partial<SourceDescriptor> = {}): SourceDescriptor {
  return {
    id: SourceType("mailbox"),
    name: "Mailbox",
    description: "Example source",
    provider: { id: ProviderType("mailbox"), name: "Mailbox" },
    authType: "none",
    ...overrides,
  };
}

describe("serializeDescriptor", () => {
  it("preserves scope item declarations, including reserved V2 capabilities, over JSON", () => {
    const scopes: SourceScopes = {
      items: [
        {
          kind: "conversation",
          noun: { one: "conversation", many: "conversations" },
          picker: "search",
          link: "fixed",
          liveSearch: true,
          keep: "before-cache",
        },
        { kind: "participant", identifiers: ["phone", "email"], link: "changes" },
        {
          kind: "folder",
          noun: { one: "folder", many: "folders" },
          picker: "tree",
          link: "hierarchy",
        },
      ],
    };
    scopes.legacyProjection = {
      conversationIdPath: ["extra", "conversationId"],
      participants: { roles: ["participant"], membership: "conversation" },
    };
    const wire = JSON.parse(JSON.stringify(serializeDescriptor(descriptor({ scopes }))));
    expect(wire.scopes).toEqual(scopes);
  });

  it("leaves filtering unsupported when a source declares no scope items", () => {
    const wire = JSON.parse(JSON.stringify(serializeDescriptor(descriptor())));
    expect(wire).not.toHaveProperty("scopes");
  });

  it("carries the document-event profile onto the wire shape unchanged", () => {
    const serialized = serializeDescriptor(descriptor({ documentEventProfile }));
    expect(serialized.documentEventProfile).toEqual(documentEventProfile);
    // The wire shape must survive a JSON round trip — it travels to the
    // gateway as the body of the collector's boot push.
    expect(JSON.parse(JSON.stringify(serialized)).documentEventProfile).toEqual(
      documentEventProfile,
    );
  });

  it("omits the profile for a source that declares none", () => {
    expect(serializeDescriptor(descriptor()).documentEventProfile).toBeUndefined();
  });

  it("serializes the multi-device mode, defaulting an undeclared source to exclusive", () => {
    expect(serializeDescriptor(descriptor()).multiDeviceMode).toBe("exclusive");
    expect(
      serializeDescriptor(descriptor({ multiDevice: { mode: "replicated" } })).multiDeviceMode,
    ).toBe("replicated");
  });

  it("serializes member-scoped params while leaving legacy params source-scoped by omission", () => {
    const serialized = serializeDescriptor(
      descriptor({
        params: [
          { name: "account", label: "Account", type: "string" },
          {
            name: "libraryPath",
            label: "Library path",
            type: "path",
            scope: "member",
            validateWhenEmpty: true,
            provesLocalAvailabilityForAccount: "local",
          },
        ],
      }),
    );

    expect(JSON.parse(JSON.stringify(serialized.params))).toEqual([
      { name: "account", label: "Account", type: "string" },
      {
        name: "libraryPath",
        label: "Library path",
        type: "path",
        scope: "member",
        validateWhenEmpty: true,
        provesLocalAvailabilityForAccount: "local",
      },
    ]);
  });
});
