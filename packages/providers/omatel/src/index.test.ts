// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCall,
  addConversation,
  addMessage,
  at,
  callsSourceId,
  omatelFixture,
  providerId,
  sourceId,
  type OmatelFixture,
} from "./testing/fixtures.js";
import omatel from "./index.js";
import type { DocumentInput } from "@omnesis/types";

let fx: OmatelFixture;
beforeEach(() => {
  fx = omatelFixture();
});
afterEach(() => fx.cleanup());

const source = (id: string) => omatel.sources.find((s) => s.id === id)!;

async function documentsOf(id: string, sid: typeof sourceId): Promise<DocumentInput[]> {
  const instance = await source(id).create(
    { accountId: "local", sourceId: sid, providerId, config: { dataDir: fx.dir } },
    {},
  );
  const page = await instance.syncStructured!(null);
  return page.documents ?? [];
}

/** Every value at a dotted metadata path, flattening arrays. */
function valuesAt(doc: DocumentInput, path: string): unknown[] {
  let value: unknown = doc.metadata;
  for (const part of path.split("."))
    value = (value as Record<string, unknown> | undefined)?.[part];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

describe("omatel provider", () => {
  it("declares two experimental Linux sources with complete icons", () => {
    expect(omatel.provider.id).toBe("omatel");
    expect(omatel.experimental).toBe(true);
    expect(omatel.supportedPlatforms).toEqual(["linux"]);
    expect(omatel.multiDevice).toEqual({ mode: "partitioned" });
    expect(omatel.sources.map((s) => s.id)).toEqual(["omatel-messages", "omatel-calls"]);
    for (const s of omatel.sources) {
      expect(s.icon).toMatchObject({
        sfSymbol: expect.any(String),
        color: expect.stringMatching(/^#[0-9A-F]{6}$/i),
        bgColor: expect.stringMatching(/^#[0-9A-F]{6}$/i),
        imageDataUri: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
      });
      expect(s.unitName).toBeTruthy();
      expect(s.documentEventProfile).toBeDefined();
    }
  });

  it("reads the folder its settings name and watches each store with its WAL", async () => {
    const instance = await source("omatel-calls").create(
      { accountId: "local", sourceId: callsSourceId, providerId, config: { dataDir: fx.dir } },
      {},
    );

    expect(instance.watchPaths).toEqual([`${fx.dir}/calls.db`, `${fx.dir}/calls.db-wal`]);
  });

  it("writes only the document types, roles and fields its profiles declare", async () => {
    const messages = fx.messages();
    const c = addConversation(messages, "+12025550141", "riley");
    addMessage(messages, c, { direction: "in", body: "lunch?", at: at("2026-03-04T11:00") });
    addCall(fx.calls(), {
      number: "+12025550141",
      direction: "out",
      outcome: "answered",
      startedAt: at("2026-03-04T11:30"),
      duration: 42,
    });

    for (const [id, sid] of [
      ["omatel-messages", sourceId],
      ["omatel-calls", callsSourceId],
    ] as const) {
      const profile = source(id).documentEventProfile!;
      const docs = await documentsOf(id, sid);
      expect(docs.length).toBeGreaterThan(0);
      for (const doc of docs) {
        expect(profile.documentTypes).toContain(doc.metadata.documentType);
        for (const person of doc.metadata.people ?? []) {
          expect(profile.personRoles).toContain(person.role);
        }
        for (const field of profile.metadataFields ?? []) {
          const values = valuesAt(doc, field.path);
          if (field.canonicalValues) {
            for (const v of values) expect(field.canonicalValues).toContain(v);
          }
        }
      }
      // Each declared field is one the documents actually carry.
      for (const field of profile.metadataFields ?? []) {
        expect(
          docs.some((doc) => valuesAt(doc, field.path).length > 0),
          field.path,
        ).toBe(true);
      }
    }
  });
});
