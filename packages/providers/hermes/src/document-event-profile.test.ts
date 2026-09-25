// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The source's `documentEventProfile` is read by the watch compiler to decide
 * which document predicates it may build. A declared field or role the push
 * path never emits compiles a condition that can never fire, so these tests
 * pin every entry of the declaration to a document the source actually
 * produces rather than to the declaration itself.
 */

import { describe, test, expect } from "vitest";
import { renderConversationDay } from "@omnesis/core";
import { validateDocumentEventProfile } from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import source from "./index.js";
import type { ConversationChat, ConversationMessage } from "@omnesis/core";
import type { DocumentMetadataFieldSpec } from "@omnesis/source-sdk";
import type { DocumentInput, PersonRole } from "@omnesis/types";

const profile = source.documentEventProfile!;

const PROVIDER = ProviderId("hermes");
const SOURCE = SourceId("hermes:local");
const AGENT = "Hermes";

const messages: ConversationMessage[] = [
  { role: "user", text: "can you draft the release note", atMs: 1_772_000_000_000 },
  { role: "assistant", text: "Here is a draft.", atMs: 1_772_000_060_000 },
  { role: "user", text: "ship it", atMs: 1_772_000_120_000 },
];

function render(chat: ConversationChat): DocumentInput {
  return renderConversationDay({
    chat,
    dayKey: "2026-02-25",
    messages,
    providerId: PROVIDER,
    sourceId: SOURCE,
    agentName: AGENT,
    harnessId: "hermes",
  });
}

/** A conversation reached through a messaging platform — the richest shape. */
function platformDoc(): DocumentInput {
  return render({
    platform: "slack",
    chatId: "c0000000001",
    chatName: "Release crew",
    chatType: "group",
  });
}

/** A session held on the host itself — the shape with no chat identity. */
function hostDoc(): DocumentInput {
  return render({ platform: "cli", chatId: "", chatName: undefined, chatType: undefined });
}

/** Resolve a declared dotted path against a document's `metadata`. */
function readPath(doc: DocumentInput, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined,
      doc.metadata,
    );
}

function matchesDeclaredType(value: unknown, type: DocumentMetadataFieldSpec["type"]): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "string-array":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
  }
}

describe("hermes documentEventProfile", () => {
  test("the declaration satisfies the source contract", () => {
    expect(() => validateDocumentEventProfile(profile, "source 'hermes'")).not.toThrow();
  });

  test("the source is published under the source type the documents carry", () => {
    // The compiler pins a plan's root predicate to `sourceType`, so the
    // descriptor id has to be the `<type>` half of the documents' source id.
    expect(source.id).toBe("hermes");
    expect(SOURCE.startsWith(`${source.id}:`)).toBe(true);
  });

  test("the declared document type is the only one the push path emits", () => {
    expect(profile.documentTypes).toEqual(["conversation"]);
    expect(platformDoc().metadata.documentType).toBe("conversation");
    expect(hostDoc().metadata.documentType).toBe("conversation");
  });

  test("the declared person roles are exactly the roles the push path emits", () => {
    // The agent's own replies are body text; the operator is the sole mention.
    const emitted = new Set<PersonRole>(
      (platformDoc().metadata.people ?? []).map((p) => p.role as PersonRole),
    );
    expect(emitted).toEqual(new Set(["participant"]));
    expect(new Set(profile.personRoles)).toEqual(emitted);
  });

  test("every declared metadata field is present, and correctly typed, on a platform conversation", () => {
    const doc = platformDoc();
    for (const field of profile.metadataFields ?? []) {
      const value = readPath(doc, field.path);
      expect(value, `${field.path} is missing`).not.toBeNull();
      expect(value, `${field.path} is missing`).toBeDefined();
      expect(matchesDeclaredType(value, field.type), `${field.path} is not a ${field.type}`).toBe(
        true,
      );
    }
  });

  test("no field is declared that the push path never writes", () => {
    // The inverse of the check above: a path that resolves to `undefined` on
    // BOTH shapes is a field the source does not have at all, and a predicate
    // over it could never match.
    const platform = platformDoc();
    const host = hostDoc();
    for (const field of profile.metadataFields ?? []) {
      const seen =
        readPath(platform, field.path) !== undefined || readPath(host, field.path) !== undefined;
      expect(seen, `${field.path} is declared but never written`).toBe(true);
    }
  });

  test("the agent name is the constant the renderer stamps", () => {
    const declared = profile.metadataFields?.find((f) => f.path === "extra.agent");
    expect(declared?.allowedValues).toEqual([AGENT]);
    expect(readPath(platformDoc(), "extra.agent")).toBe(AGENT);
  });

  test("tags carry the harness and the channel, in that order", () => {
    expect(platformDoc().metadata.tags).toEqual(["hermes", "slack"]);
    expect(hostDoc().metadata.tags).toEqual(["hermes", "cli"]);
    const declared = profile.metadataFields?.find((f) => f.path === "tags");
    // An open vocabulary: the channel is whatever the harness was reached
    // through, so the known values must be canonical rather than exhaustive.
    expect(declared?.canonicalValues).toContain("hermes");
    expect(declared?.allowedValues).toBeUndefined();
  });

  test("the chat-identity fields are declared as identifying people", () => {
    // A direct-message id or name singles out the person on the other end, so
    // the operator must see the condition disclosed as one about a person.
    for (const path of ["extra.chatId", "extra.chatName"]) {
      const declared = profile.metadataFields?.find((f) => f.path === path);
      expect(declared?.identifiesPeople, `${path} must declare identifiesPeople`).toBe(true);
    }
  });

  test("the chat-identity fields are absent on a host session", () => {
    const host = hostDoc();
    expect(readPath(host, "extra.chatId")).toBeNull();
    expect(readPath(host, "extra.chatName")).toBeNull();
    expect(readPath(host, "extra.chatType")).toBeNull();
  });

  test("the message count is the number of turns in the day", () => {
    expect(readPath(platformDoc(), "extra.messageCount")).toBe(messages.length);
  });

  test("the constant-valued fields the renderer writes are deliberately not declared", () => {
    // `extra.harness`, `extra.provenance` and `rollingAggregate` hold the same
    // value on every document of this source, so a filter over them cannot
    // discriminate. They are populated — this pins that leaving them out is a
    // choice, not an oversight.
    const doc = platformDoc();
    expect(readPath(doc, "extra.harness")).toBe("hermes");
    expect(readPath(doc, "extra.provenance")).toBe("harness-pushed");
    expect(readPath(doc, "rollingAggregate")).toBe(true);
    const declared = new Set((profile.metadataFields ?? []).map((f) => f.path));
    expect(declared.has("extra.harness")).toBe(false);
    expect(declared.has("extra.provenance")).toBe(false);
    expect(declared.has("rollingAggregate")).toBe(false);
  });
});
