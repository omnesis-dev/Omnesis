// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { NotesService, notePage, renderedNoteLength, type NoteDraft } from "./notes-service.js";
import type { ExtensionConfig } from "./storage.js";

const PAGE = {
  url: "https://example.org/article",
  title: "Example article",
  selection: "An invented quotation",
};
function harness() {
  let stored: unknown;
  let config: ExtensionConfig | null = {
    gatewayUrl: "https://gateway.example.org",
    deviceId: "11111111-1111-4111-8111-111111111111",
    scopes: ["write:web"],
    token: "web-token",
    pairedAt: 1,
  };
  let supported = true,
    approved = false,
    revoked = false,
    offline = false,
    failSubmit = false;
  let requestId = "";
  let rejectSubmit = false,
    badAck = false;
  let capability: unknown = { min: 1, max: 2 };
  const accepted = new Map<string, unknown>();
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (offline) throw new Error("offline");
    const url = String(input);
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith("/health"))
      return respond({ capabilities: supported ? { browserNotes: capability } : {} });
    if (url.endsWith("/authorization")) {
      requestId = JSON.parse(String(init?.body)).id;
      return respond({ requestId, approvalPath: `/portal/browser-notes?id=${requestId}` });
    }
    if (url.includes("/authorization/"))
      return respond(
        revoked
          ? { status: "revoked" }
          : approved
            ? {
                status: "approved",
                credential: {
                  deviceId: config!.deviceId,
                  token: "note-token",
                  scopes: ["notes:create"],
                },
              }
            : { status: "pending" },
      );
    if (revoked) return respond({ error: "revoked" }, 401);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { id: string };
      if (rejectSubmit) return respond({ error: "conflict" }, 409);
      if (badAck) return respond({});
      accepted.set(body.id, body);
      if (failSubmit) {
        failSubmit = false;
        throw new Error("response lost after save");
      }
      return respond({ id: body.id, deviceId: config!.deviceId, surface: "chrome-extension" }, 201);
    }
    return respond({ enabled: true });
  });
  const deps = {
    config: async () => config,
    read: async () => structuredClone(stored),
    write: async (state: unknown) => {
      stored = structuredClone(state);
    },
    fetch: fetch as typeof globalThis.fetch,
  };
  const service = new NotesService(deps);
  return {
    service,
    fetch,
    accepted,
    mutateStored: (fn: (state: Record<string, unknown>) => void) =>
      fn(stored as Record<string, unknown>),
    setRejectSubmit: (value: boolean) => {
      rejectSubmit = value;
    },
    setBadAck: () => {
      badAck = true;
    },
    setCapability: (value: unknown) => {
      capability = value;
    },
    restart: () => new NotesService(deps),
    setSupported: (value: boolean) => {
      supported = value;
    },
    setApproved: () => {
      approved = true;
    },
    setOffline: (value: boolean) => {
      offline = value;
    },
    revoke: () => {
      revoked = true;
    },
    loseSubmitResponse: () => {
      failSubmit = true;
    },
    setConfig: (value: ExtensionConfig | null) => {
      config = value;
    },
  };
}
async function enabled(h: ReturnType<typeof harness>) {
  await h.service.activate();
  h.setApproved();
  await h.service.status();
}

describe("browser notes", () => {
  it("hides optional notes on gateways without the capability", async () => {
    const h = harness();
    h.setSupported(false);
    expect(await h.service.status()).toMatchObject({ supported: false, enabled: false });
    expect((await h.service.begin(PAGE)).draft).toBeNull();
    await expect(h.service.activate()).rejects.toThrow("does not support");
    expect(h.fetch.mock.calls.every(([url]) => String(url).endsWith("/health"))).toBe(true);
  });
  it("requires owner approval and stores a separate create-only credential", async () => {
    const h = harness();
    await h.service.activate();
    expect(await h.service.status()).toMatchObject({
      supported: true,
      enabled: false,
      pendingApproval: true,
    });
    h.setApproved();
    expect(await h.service.status()).toMatchObject({ enabled: true, pendingApproval: false });
    await h.service.begin(PAGE);
    const draft = (await h.service.status()).draft!;
    await h.service.update(draft.id, "My invented note");
    await h.service.submit(draft.id);
    await h.service.drain();
    const posts = h.fetch.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/browser/notes") && init?.method === "POST",
    );
    expect(posts[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer note-token" });
    expect([...h.accepted.values()][0]).toMatchObject({
      version: 1,
      text: "My invented note",
      page: PAGE,
    });
  });
  it("keeps a draft's original page and quotation across tabs and worker restarts", async () => {
    const h = harness();
    await enabled(h);
    const draft = (await h.service.begin(PAGE)).draft!;
    await h.service.update(draft.id, "An unfinished thought");
    const restarted = h.restart();
    const view = await restarted.begin({
      ...PAGE,
      url: "https://example.org/other",
      selection: "Another passage",
    });
    expect(view.draft).toMatchObject({ ...PAGE, text: "An unfinished thought", id: draft.id });
  });
  it("persists queued notes offline and retries the exact ID after an ambiguous response", async () => {
    const h = harness();
    await enabled(h);
    const draft = (await h.service.begin(PAGE)).draft!;
    await h.service.update(draft.id, "Remember this");
    h.setOffline(true);
    expect(await h.service.submit(draft.id)).toMatchObject({ pending: 1, draft: null });
    expect(await h.restart().drain()).toMatchObject({ pending: 1 });
    h.setOffline(false);
    h.loseSubmitResponse();
    expect(await h.service.drain()).toMatchObject({ pending: 1 });
    expect(await h.restart().drain()).toMatchObject({ pending: 0, lastSavedId: draft.id });
    expect(h.accepted.size).toBe(1);
  });
  it("preserves drafts when the gateway is downgraded", async () => {
    const h = harness();
    await enabled(h);
    const draft = (await h.service.begin(PAGE)).draft!;
    await h.service.update(draft.id, "Keep this draft");
    h.setSupported(false);
    await expect(h.service.submit(draft.id)).rejects.toThrow("draft is kept");
    expect(await h.service.status()).toMatchObject({
      enabled: false,
      draft: { id: draft.id, text: "Keep this draft" },
    });
  });
  it("detects revoked notes authorization without changing capture pairing", async () => {
    const h = harness();
    await enabled(h);
    await h.service.begin(PAGE);
    h.revoke();
    expect(await h.service.status()).toMatchObject({
      supported: true,
      enabled: false,
      pendingApproval: false,
    });
  });
  it("does not send old pairing notes to a replacement gateway", async () => {
    const h = harness();
    await enabled(h);
    const draft = (await h.service.begin(PAGE)).draft!;
    await h.service.update(draft.id, "Do not cross gateways");
    await h.service.submit(draft.id);
    h.setConfig({
      gatewayUrl: "https://different.example.org",
      deviceId: "22222222-2222-4222-8222-222222222222",
      scopes: ["write:web"],
      token: "new-web-token",
      pairedAt: 2,
    });
    expect(await h.service.drain()).toMatchObject({ pending: 0, enabled: false, draft: null });
    expect(h.accepted.size).toBe(0);
  });
  it("serializes concurrent draft updates and refuses stale panel submissions", async () => {
    const h = harness();
    await enabled(h);
    const draft = (await h.service.begin(PAGE)).draft!;
    await Promise.all([h.service.update(draft.id, "first"), h.service.update(draft.id, "second")]);
    expect((await h.service.status()).draft?.text).toBe("second");
    await h.service.submit(draft.id);
    await expect(h.service.submit(draft.id)).rejects.toThrow("Write a note");
    expect((await h.service.status()).pending).toBe(1);
  });
  it("validates the complete note budget before removing the draft", async () => {
    const h = harness();
    await enabled(h);
    const draft = (await h.service.begin(PAGE)).draft!;
    await h.service.update(draft.id, "x".repeat(8192));
    await expect(h.service.submit(draft.id)).rejects.toThrow("Shorten");
    expect((await h.service.status()).draft?.id).toBe(draft.id);
    expect(renderedNoteLength({ ...draft, text: "Hello" } as NoteDraft)).toBeGreaterThan(
      5 + PAGE.url.length,
    );
  });
  it("rejects malformed or unsupported capability ranges", async () => {
    for (const range of [
      { min: 2, max: 3 },
      { min: 0, max: 1 },
      { min: 1, max: 0 },
      { min: 1, max: 1.5 },
      { min: 1, max: "2" },
    ]) {
      const h = harness();
      h.setCapability(range);
      expect((await h.service.status()).enabled).toBe(false);
      expect((await h.service.status()).supported).toBe(false);
    }
  });
  it("keeps valid queued notes when a sibling stored record is damaged", async () => {
    const h = harness();
    await enabled(h);
    const draft = (await h.service.begin(PAGE)).draft!;
    await h.service.update(draft.id, "Keep the valid note");
    await h.service.submit(draft.id);
    h.mutateStored((state) => {
      (state.queue as unknown[]).push({ text: "Damaged note content" });
    });
    const view = await h.restart().drain();
    expect(view.pending).toBe(1);
    expect(view.error).toContain("recovery");
    expect(h.accepted.size).toBe(1);
  });
  it("rejects oversized updates without damaging the outbox or current draft", async () => {
    const h = harness();
    await enabled(h);
    const draft = (await h.service.begin(PAGE)).draft!;
    await expect(h.service.update(draft.id, "x".repeat(8193))).rejects.toThrow("too long");
    expect((await h.service.status()).draft?.id).toBe(draft.id);
  });
  it("retains an ambiguous successful response unless it confirms the same note", async () => {
    const h = harness();
    await enabled(h);
    const draft = (await h.service.begin(PAGE)).draft!;
    await h.service.update(draft.id, "Confirm this note");
    await h.service.submit(draft.id);
    h.setBadAck();
    expect(await h.service.drain()).toMatchObject({ pending: 1 });
    expect((await h.service.status()).lastSavedId).toBeUndefined();
  });
  it("lets users edit rejected notes and continues delivering later notes", async () => {
    const h = harness();
    await enabled(h);
    const draft = (await h.service.begin(PAGE)).draft!;
    await h.service.update(draft.id, "First note");
    await h.service.submit(draft.id);
    h.setRejectSubmit(true);
    expect((await h.service.drain()).rejected).toEqual([{ id: draft.id, title: PAGE.title }]);
    const next = (await h.service.begin({ ...PAGE, url: "https://example.org/next" })).draft!;
    await h.service.update(next.id, "Second note");
    await h.service.submit(next.id);
    h.setRejectSubmit(false);
    expect((await h.service.drain()).pending).toBe(1);
    expect(h.accepted.size).toBe(1);
    expect((await h.service.restore(draft.id)).draft).toMatchObject({
      ...PAGE,
      text: "First note",
    });
  });
  it("delivers a recovered offline backlog promptly in order", async () => {
    const h = harness();
    await enabled(h);
    const ids: string[] = [];
    h.setOffline(true);
    for (let index = 0; index < 5; index++) {
      const draft = (await h.service.begin(PAGE)).draft!;
      ids.push(draft.id);
      await h.service.update(draft.id, `Invented note ${index}`);
      await h.service.submit(draft.id);
    }
    h.setOffline(false);
    expect((await h.restart().drain()).pending).toBe(0);
    expect([...h.accepted.keys()]).toEqual(ids);
  });
  it("starts a new note on another page after explicitly discarding a draft", async () => {
    const h = harness();
    await enabled(h);
    const old = (await h.service.begin(PAGE)).draft!;
    await h.service.update(old.id, "A thought to abandon");
    await h.service.discard(old.id);
    const current = (
      await h.service.begin({
        ...PAGE,
        url: "https://example.org/new",
        selection: "Different passage",
      })
    ).draft!;
    expect(current.id).not.toBe(old.id);
    expect(current.url).toBe("https://example.org/new");
    expect(current.text).toBe("");
    expect(current.selection).toBe("Different passage");
  });
  it("rejects unsafe page contexts", () => {
    for (const url of ["javascript:alert(1)", "https://user:pass@example.org", "file:///tmp/a"])
      expect(notePage({ ...PAGE, url })).toBeNull();
  });
});
