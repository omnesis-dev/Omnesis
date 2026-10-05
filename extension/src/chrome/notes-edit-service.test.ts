// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { NotesEditService } from "./notes-edit-service.js";
import type { ExtensionConfig } from "./storage.js";

function harness() {
  let stored: unknown,
    config: ExtensionConfig | null = {
      gatewayUrl: "https://gateway.example.org",
      deviceId: "11111111-1111-4111-8111-111111111111",
      token: "capture",
      scopes: ["write:web"],
      pairedAt: 1,
    };
  let experimental = true,
    conflict = false;
  let entry = {
    id: "22222222-2222-4222-8222-222222222222",
    documentId: "day-document",
    text: "Invented note",
    revision: "1".repeat(64),
    capturedAt: "2030-01-01T12:00:00Z",
    updatedAt: "2030-01-01T12:00:00Z",
    page: { url: "https://example.org/guide" },
    editable: true,
  };
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    let value: unknown;
    let status = 200;
    if (url.pathname === "/health")
      value = {
        experimental,
        capabilities: { browserFeatures: { min: 1, max: 1 }, browserNotesEdit: { min: 1, max: 1 } },
      };
    else if (url.pathname.endsWith("/enable"))
      value = {
        status: "approved",
        credential: {
          deviceId: config!.deviceId,
          tokenId: "33333333-3333-4333-8333-333333333333",
          token: "edit",
          scopes: ["notes:update"],
        },
      };
    else if (init?.method === "PATCH") {
      if (conflict) {
        status = 409;
        value = {};
      } else {
        const body = JSON.parse(String(init.body)) as { text: string };
        entry = { ...entry, text: body.text.trim(), revision: "2".repeat(64) };
        value = entry;
      }
    } else value = { notes: [entry] };
    return new Response(JSON.stringify(value), { status });
  });
  const deps = {
    config: async () => config,
    read: async () => structuredClone(stored),
    write: async (value: unknown) => {
      stored = structuredClone(value);
    },
    readToken: async () => "read",
    ensureRead: vi.fn().mockResolvedValue(undefined),
    fetch,
  };
  return {
    service: new NotesEditService(deps),
    deps,
    fetch,
    entry,
    experimental: (value: boolean) => {
      experimental = value;
    },
    conflict: () => {
      conflict = true;
      entry = { ...entry, text: "A newer invented note", revision: "3".repeat(64) };
    },
    offline: () => {
      fetch.mockRejectedValue(new Error("Invented network outage"));
    },
    unpair: () => {
      config = null;
    },
  };
}
describe("saved browser notes", () => {
  it("lists graph-associated notes with read and edits a specific ledger entry with independent update authority", async () => {
    const h = harness();
    const list = await h.service.list(h.entry.page.url);
    expect(list.notes[0]).toMatchObject({
      id: h.entry.id,
      documentId: "day-document",
      text: "Invented note",
    });
    expect(JSON.stringify(list)).not.toContain('"token"');
    await h.service.select(h.entry.id, h.entry.page.url);
    await h.service.update("Changed invented note");
    expect(await h.service.save()).toMatchObject({
      draft: { text: "Changed invented note", revision: "2".repeat(64) },
    });
    const call = h.fetch.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(call[1]?.headers).toMatchObject({ authorization: "Bearer edit" });
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      version: 1,
      url: h.entry.page.url,
      text: "Changed invented note",
      revision: "1".repeat(64),
    });
    const read = h.fetch.mock.calls.find(([url]) => String(url).includes("?url="))!;
    expect(read[1]?.headers).toMatchObject({ authorization: "Bearer read" });
  });
  it("preserves authored edits and old revision on conflict, including panel/worker reopening", async () => {
    const h = harness();
    await h.service.select(h.entry.id, h.entry.page.url);
    await h.service.update("Unsaved invention");
    h.conflict();
    expect(await h.service.save()).toMatchObject({
      draft: { text: "Unsaved invention", revision: "1".repeat(64) },
      error: expect.stringContaining("changed"),
    });
    expect(await new NotesEditService(h.deps).list(h.entry.page.url)).toMatchObject({
      draft: { text: "Unsaved invention" },
    });
    await h.service.discard();
    expect(await h.service.select(h.entry.id, h.entry.page.url)).toMatchObject({
      draft: { text: "A newer invented note", revision: "3".repeat(64) },
    });
  });
  it("hides saved data and pauses existing edit authority when experimental mode turns off", async () => {
    const h = harness();
    await h.service.select(h.entry.id, h.entry.page.url);
    await h.service.update("Kept invention");
    h.experimental(false);
    expect(await h.service.list(h.entry.page.url)).toMatchObject({ enabled: false, notes: [] });
    expect(await h.deps.read()).toMatchObject({ draft: { text: "Kept invention" } });
    expect(await h.deps.read()).not.toHaveProperty("token");
    expect(h.fetch.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
  });
  it("keeps the saved editor and written draft visible during a transport outage", async () => {
    const h = harness();
    await h.service.select(h.entry.id, h.entry.page.url);
    await h.service.update("Kept offline invention");
    h.offline();
    expect(await h.service.list(h.entry.page.url)).toMatchObject({
      enabled: true,
      draft: { text: "Kept offline invention" },
    });
  });
  it("rejects pairing changes without restoring stale private authority", async () => {
    const h = harness();
    await h.service.select(h.entry.id, h.entry.page.url);
    h.unpair();
    expect(await h.service.save()).toEqual({ enabled: false, url: "", notes: [] });
  });
});
