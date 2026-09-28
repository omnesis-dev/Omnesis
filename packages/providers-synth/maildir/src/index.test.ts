// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeSourceHost } from "@omnesis/source-sdk/testing";
import { ProviderId, SourceId } from "@omnesis/types";
import { loadMessages } from "./fixtures.js";
import definition from "./index.js";
import type { MaildirCursor } from "@omnesis/provider-maildir";
import type { DocumentInput } from "@omnesis/types";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "omnesis-maildir-synth-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

test("keeps its discovered account without a real folder", async () => {
  vi.stubEnv("OMNESIS_SYNTH_PRE_DISCOVERED", "1");
  expect(definition.resolveAccountId).toBeUndefined();
  expect(definition.config).toBeUndefined();
  expect(await definition.discover?.()).toEqual(["mail-synth-johnsmith"]);
});

test("syncs the universe's messages through the real source, one document each", async () => {
  const instance = await definition.create!({
    accountId: "mail-synth-johnsmith",
    sourceId: SourceId("maildir:mail-synth-johnsmith"),
    providerId: ProviderId("maildir:mail-synth-johnsmith"),
    host: fakeSourceHost({ stateDir }),
  });
  const documents: DocumentInput[] = [];
  let cursor: MaildirCursor | null = null;
  let present: string[] | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await instance.sync(cursor);
    documents.push(...result.documents);
    cursor = result.cursor;
    if (!result.hasMore) {
      present = result.presentExternalIds;
      break;
    }
  }
  await instance.dispose?.();
  const fixtures = loadMessages();
  expect(documents).toHaveLength(fixtures.length);
  expect(present).toHaveLength(fixtures.length);
  const workshop = documents.find((d) => d.title === "Globex workshop agenda")!;
  expect(workshop.metadata.tags).toEqual(["INBOX", "Work", "[Gmail]/All Mail"]);
  expect(workshop.metadata.extra?.flagged).toBe(true);
  const reply = documents.find((d) => d.title === "Re: Bike club ride on Saturday")!;
  const original = documents.find((d) => d.title === "Bike club ride on Saturday")!;
  expect(reply.metadata.extra?.threadId).toBe(original.metadata.extra?.threadId);
  expect(reply.metadata.people?.[0]).toMatchObject({
    role: "sender",
    emails: ["john.smith@example.com"],
  });
});
