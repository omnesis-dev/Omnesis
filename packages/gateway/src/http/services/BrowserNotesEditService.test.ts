// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DeviceId, TokenId, Scope } from "@omnesis/types";
import { BrowserNotesEditService } from "./BrowserNotesEditService.js";
import type { BrowserNoteEditResult } from "../../sources/omnesis-notes/storage.js";
import type { DeviceService } from "./DeviceService.js";
import type { AuthContext } from "../routes/types.js";
import type { OmnesisNotesRuntime, NoteEntry } from "../../sources/omnesis-notes/index.js";

beforeEach(() => vi.stubEnv("OMNESIS_EXPERIMENTAL", "1"));
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const auth: AuthContext = {
    authMethod: "bearer",
    deviceId: DeviceId(randomUUID()),
    tokenId: TokenId(randomUUID()),
    scopes: [Scope("read")],
  };
  const entry: NoteEntry = {
    id: randomUUID(),
    day: "2026-06-15",
    text: "A page thought https://example.org/article",
    capturedAt: "2026-06-15T12:00:00.000Z",
    updatedAt: "2026-06-15T12:00:00.000Z",
    surface: "portal",
    deviceId: null,
    capturedTimeZoneId: null,
    capturedUtcOffsetSeconds: null,
    receivedAt: null,
    latitude: null,
    longitude: null,
    placeName: null,
  };
  const listBrowser = vi.fn(() => [{ documentId: "notes-day", entry }]);
  const editBrowser = vi.fn(
    async (): Promise<BrowserNoteEditResult> => ({
      outcome: "updated" as const,
      entry,
      documentId: "notes-day",
    }),
  );
  const tokenIsActive = vi.fn(() => true);
  const service = new BrowserNotesEditService({
    devices: {
      getById: () => ({ kind: "browser", revokedAt: null }),
      tokenIsActive,
    } as unknown as DeviceService,
    writeGate: { createToken: vi.fn(), revokeToken: vi.fn() },
    runtime: () => ({ listBrowser, editBrowser }) as unknown as OmnesisNotesRuntime,
    scope: "notes:update",
    label: "Browser notes editing",
    feature: "browser-notes-edit",
  });
  return { auth, entry, service, listBrowser, editBrowser, tokenIsActive };
}

test("read authority lists associated entries with opaque revisions and sanitized page URL", () => {
  const f = fixture();
  expect(
    f.service.list(f.auth, "https://user:secret@example.org/article?token=secret"),
  ).toMatchObject({
    notes: [
      {
        id: f.entry.id,
        documentId: "notes-day",
        text: f.entry.text,
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
        editable: true,
      },
    ],
  });
  expect(f.listBrowser).toHaveBeenCalledWith(f.auth.deviceId, "https://example.org/article");
  expect(() =>
    f.service.list({ ...f.auth, scopes: [Scope("notes:create")] }, "https://example.org/article"),
  ).toThrow(expect.objectContaining({ status: 403 }));
});

test("create-only and read credentials cannot update saved notes", async () => {
  const f = fixture();
  for (const scope of ["read", "notes:create", "write:web"])
    await expect(
      f.service.edit({ ...f.auth, scopes: [Scope(scope)] }, f.entry.id, {
        url: "https://example.org/article",
        text: "Changed",
        revision: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 403 });
  expect(f.editBrowser).not.toHaveBeenCalled();
});

test("edits expose conflicts and recheck authority after a queued write", async () => {
  const f = fixture();
  const auth = { ...f.auth, scopes: [Scope("notes:update")] };
  const input = { url: "https://example.org/article", text: "Changed", revision: "a".repeat(64) };
  f.editBrowser.mockImplementationOnce(async () => ({ outcome: "conflict" }));
  await expect(f.service.edit(auth, f.entry.id, input)).rejects.toMatchObject({
    status: 409,
    code: "NOTE_EDIT_CONFLICT",
  });
  f.editBrowser.mockImplementationOnce(async () => {
    f.tokenIsActive.mockReturnValue(false);
    return { outcome: "updated", entry: f.entry, documentId: "notes-day" };
  });
  await expect(f.service.edit(auth, f.entry.id, input)).rejects.toMatchObject({ status: 403 });
});

test("strict off blocks existing read and edit credentials even with synthetic mode", async () => {
  const f = fixture();
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  vi.stubEnv("OMNESIS_SYNTHETIC", "1");
  expect(() => f.service.list(f.auth, "https://example.org/article")).toThrow(
    expect.objectContaining({ status: 404 }),
  );
  await expect(
    f.service.edit({ ...f.auth, scopes: [Scope("notes:update")] }, f.entry.id, {
      url: "https://example.org/article",
      text: "Changed",
      revision: "a".repeat(64),
    }),
  ).rejects.toMatchObject({ status: 404 });
  expect(f.listBrowser).not.toHaveBeenCalled();
  expect(f.editBrowser).not.toHaveBeenCalled();
});
