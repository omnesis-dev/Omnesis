// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DeviceId, TokenId, Scope } from "@omnesis/types";
import { runSchemaSetup } from "../../data/schema.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { bootOmnesisNotes } from "../../sources/omnesis-notes/index.js";
import { getNoteEntry } from "../../sources/omnesis-notes/storage.js";
import {
  browserNoteContext,
  browserNoteRevision,
} from "../../sources/omnesis-notes/browser-note.js";
import { BrowserAuthorizationService } from "./BrowserAuthorizationService.js";
import { BrowserNotesService } from "./BrowserNotesService.js";
import type { AuthContext } from "../routes/types.js";
import type { DeviceService } from "./DeviceService.js";
import type { CaptureNoteInput, OmnesisNotesRuntime } from "../../sources/omnesis-notes/index.js";

function fixture() {
  const deviceId = DeviceId(randomUUID());
  const tokenId = TokenId(randomUUID());
  const mintedId = TokenId(randomUUID());
  const tokens = new Set([tokenId]);
  let now = 1000;
  const auth: AuthContext = {
    authMethod: "bearer",
    deviceId,
    tokenId,
    scopes: [Scope("write:web")],
  };
  const createToken = vi.fn(async () => {
    tokens.add(mintedId);
    return { id: mintedId, token: "fictional-secret" };
  });
  const revokeToken = vi.fn(async (id: TokenId) => tokens.delete(id));
  const devices = {
    getById: vi.fn(() => ({
      id: deviceId,
      name: "Example browser",
      kind: "browser",
      revokedAt: null,
    })),
    tokenIsActive: vi.fn((id: TokenId) => tokens.has(id)),
    listTokens: vi.fn(() => [...tokens].map((id) => ({ id }))),
  } as unknown as DeviceService;
  const capture = vi.fn(async (input: CaptureNoteInput) => ({ ...input, day: "2026-01-01" }));
  const runtime = () => ({ capture }) as unknown as OmnesisNotesRuntime;
  const service = new BrowserNotesService({
    devices,
    writeGate: { createToken, revokeToken },
    runtime,
    now: () => now,
  });
  return {
    service,
    auth,
    deviceId,
    tokenId,
    mintedId,
    tokens,
    createToken,
    revokeToken,
    capture,
    advance: () => {
      now += 600_001;
    },
  };
}

describe("browser notes optional authority", () => {
  beforeEach(() => vi.stubEnv("OMNESIS_EXPERIMENTAL", "1"));
  afterEach(() => vi.unstubAllEnvs());

  test.each([undefined, "0"])(
    "default-off gate rejects existing approved authority (%s), including synthetic mode",
    async (flag) => {
      const f = fixture();
      const request = f.service.createAuthorization(f.auth, randomUUID());
      await f.service.approve(request.requestId);
      const notesAuth = { ...f.auth, tokenId: f.mintedId, scopes: [Scope("notes:create")] };
      vi.stubEnv("OMNESIS_EXPERIMENTAL", flag);
      vi.stubEnv("OMNESIS_SYNTHETIC", "1");
      for (const operation of [
        () => f.service.createAuthorization(f.auth, randomUUID()),
        () => f.service.poll(f.auth, request.requestId),
        () => f.service.authorization(request.requestId),
        () => f.service.status(notesAuth),
      ])
        expect(operation).toThrow(expect.objectContaining({ status: 404 }));
      await expect(f.service.approve(request.requestId)).rejects.toMatchObject({ status: 404 });
      await expect(
        f.service.capture(notesAuth, {
          id: randomUUID(),
          text: "A thought",
          page: { url: "https://example.org/article" },
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(f.createToken).toHaveBeenCalledTimes(1);
      expect(f.capture).not.toHaveBeenCalled();
    },
  );

  test("approval revokes a newly minted token when the experimental gate closes while queued", async () => {
    const f = fixture();
    const request = f.service.createAuthorization(f.auth, randomUUID());
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.createToken.mockImplementationOnce(async () => {
      await waiting;
      f.tokens.add(f.mintedId);
      return { id: f.mintedId, token: "fictional-secret" };
    });
    const approval = f.service.approve(request.requestId);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    release();
    await expect(approval).rejects.toMatchObject({ status: 404 });
    expect(f.revokeToken).toHaveBeenCalledExactlyOnceWith(f.mintedId);
    expect(f.tokens.has(f.mintedId)).toBe(false);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    expect(f.service.poll(f.auth, request.requestId)).toEqual({ status: "pending" });
  });

  test("an in-flight idempotent capture cannot return data after experimental mode is disabled", async () => {
    const f = fixture();
    f.capture.mockImplementationOnce(async (input) => {
      vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
      return { ...input, day: "2026-01-01" };
    });
    await expect(
      f.service.capture(
        { ...f.auth, scopes: [Scope("notes:create")] },
        { id: randomUUID(), text: "A thought", page: { url: "https://example.org/article" } },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("queued writer gate failure maps to 404", async () => {
    const f = fixture();
    f.capture.mockRejectedValueOnce(
      Object.assign(new Error("Feature unavailable"), { name: "BrowserNotesUnavailableError" }),
    );
    await expect(
      f.service.capture(
        { ...f.auth, scopes: [Scope("notes:create")] },
        { id: randomUUID(), text: "A thought", page: { url: "https://example.org/article" } },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test.each(["notes:create", "notes:update", "read"])(
    "automatic feature enable mints only %s and deduplicates concurrent retries",
    async (scope) => {
      const f = fixture();
      const service = new BrowserAuthorizationService({
        devices: {
          getById: () => ({ kind: "browser", revokedAt: null }),
          tokenIsActive: (id: TokenId) => f.tokens.has(id),
          listTokens: () => [...f.tokens].map((id) => ({ id })),
        } as unknown as DeviceService,
        writeGate: { createToken: f.createToken, revokeToken: f.revokeToken },
        scope,
        label: "Browser capability",
        feature: "browser-feature",
      });
      const id = randomUUID();
      const replies = await Promise.all([
        service.enable(f.auth, id),
        service.enable(f.auth, randomUUID()),
      ]);
      expect(replies[0]).toEqual(replies[1]);
      expect(replies[0]).toMatchObject({
        status: "approved",
        credential: { deviceId: f.deviceId, scopes: [scope] },
      });
      expect(f.createToken).toHaveBeenCalledExactlyOnceWith(
        f.deviceId,
        [Scope(scope)],
        "Browser capability",
      );
      expect(f.auth.scopes).toEqual(["write:web"]);
      vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
      await expect(service.enable(f.auth, id)).rejects.toMatchObject({ status: 404 });
      expect(f.createToken).toHaveBeenCalledTimes(1);
    },
  );

  test("automatic enable revokes an in-flight grant when the capture pairing is revoked", async () => {
    const f = fixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.createToken.mockImplementationOnce(async () => {
      await waiting;
      f.tokens.add(f.mintedId);
      return { id: f.mintedId, token: "fictional-secret" };
    });
    const grant = f.service.enable(f.auth, randomUUID());
    f.tokens.delete(f.tokenId);
    release();
    await expect(grant).rejects.toMatchObject({ status: 403 });
    expect(f.revokeToken).toHaveBeenCalledExactlyOnceWith(f.mintedId);
    expect(f.tokens.has(f.mintedId)).toBe(false);
  });

  test("only an approved request yields a separate create-only credential", async () => {
    const f = fixture();
    const request = f.service.createAuthorization(f.auth, randomUUID());
    expect(f.service.poll(f.auth, request.requestId)).toEqual({ status: "pending" });
    await f.service.approve(request.requestId);
    expect(f.createToken).toHaveBeenCalledWith(
      f.deviceId,
      [Scope("notes:create")],
      "Browser Tell Omnesis",
    );
    expect(f.service.poll(f.auth, request.requestId)).toMatchObject({
      status: "approved",
      credential: { token: "fictional-secret", scopes: ["notes:create"] },
    });
    expect(f.auth.scopes).toEqual(["write:web"]);
  });
  test("a sibling token cannot obtain the approved credential", async () => {
    const f = fixture();
    const request = f.service.createAuthorization(f.auth, randomUUID());
    await f.service.approve(request.requestId);
    const siblingId = TokenId(randomUUID());
    f.tokens.add(siblingId);
    expect(() => f.service.poll({ ...f.auth, tokenId: siblingId }, request.requestId)).toThrow(
      "Authorization not found",
    );
    expect(f.service.poll(f.auth, request.requestId)).toMatchObject({
      status: "approved",
      credential: { token: "fictional-secret", tokenId: f.mintedId },
    });
  });
  test("concurrent approval mints one credential and revocation does not resurrect it", async () => {
    const f = fixture();
    const request = f.service.createAuthorization(f.auth, randomUUID());
    await Promise.all([f.service.approve(request.requestId), f.service.approve(request.requestId)]);
    expect(f.createToken).toHaveBeenCalledTimes(1);
    f.tokens.delete(f.mintedId);
    expect(f.service.poll(f.auth, request.requestId)).toEqual({ status: "revoked" });
    await expect(f.service.approve(request.requestId)).rejects.toThrow("revoked");
    expect(() => f.service.authorization(request.requestId)).toThrow("revoked");
    expect(f.createToken).toHaveBeenCalledTimes(1);
    const fresh = f.service.createAuthorization(f.auth, randomUUID());
    expect(fresh.requestId).not.toBe(request.requestId);
    expect(f.service.poll(f.auth, fresh.requestId)).toEqual({ status: "pending" });
  });
  test("expired requests and inactive original credentials cannot be approved", async () => {
    const f = fixture();
    const request = f.service.createAuthorization(f.auth, randomUUID());
    f.tokens.delete(f.tokenId);
    await expect(f.service.approve(request.requestId)).rejects.toThrow("no longer active");
    expect(f.createToken).not.toHaveBeenCalled();
    f.tokens.add(f.tokenId);
    f.advance();
    expect(() => f.service.poll(f.auth, request.requestId)).toThrow("expired");
  });
  test("credentials are stripped from page context and combined length stays editable", async () => {
    const f = fixture();
    const auth = { ...f.auth, scopes: [Scope("notes:create")] };
    const note = await f.service.capture(auth, {
      id: randomUUID(),
      text: "A thought",
      page: { url: "https://user:secret@example.org/article?token=private&keep=yes" },
    });
    expect(note.page?.url).toBe("https://example.org/article?keep=yes");
    expect(note.text).not.toContain("secret");
    expect(note.text).not.toContain("private");
    await expect(
      f.service.capture(auth, {
        id: randomUUID(),
        text: "a".repeat(8192),
        page: { url: "https://example.org/article" },
      }),
    ).rejects.toThrow("fit within 8192");
  });
  test("ambiguous creation retries acknowledge later browser and portal edits without replacing them", async () => {
    const db = new Database(":memory:");
    runSchemaSetup(db);
    const device = createDevice(db, { name: "Example browser", kind: "browser" });
    const sibling = createDevice(db, { name: "Second example browser", kind: "browser" });
    const create = createToken(db, device.id, [Scope("notes:create")]);
    const update = createToken(db, sibling.id, [Scope("notes:update")]);
    const activeTokens = new Set([create.id, update.id]);
    const writeGate = directWriteGate(db);
    const runtime = bootOmnesisNotes({
      writeGate,
      readDb: db,
      ingest: async () => {},
      deleteByIds: async () => {},
      debounceMs: 0,
    });
    const service = new BrowserNotesService({
      devices: {
        getById: () => device,
        tokenIsActive: (id: TokenId) => activeTokens.has(id),
      } as unknown as DeviceService,
      writeGate,
      runtime: () => runtime,
    });
    const auth: AuthContext = {
      authMethod: "bearer",
      deviceId: device.id,
      tokenId: create.id,
      scopes: [Scope("notes:create")],
    };
    const input = {
      id: randomUUID(),
      text: "Original thought",
      page: {
        url: "https://example.org/article",
        title: "Example article",
        selection: "Quoted passage",
      },
    };
    try {
      const first = await service.capture(auth, input);
      expect(first.page).toEqual(input.page);
      const stored = getNoteEntry(db, first.id)!;
      expect(stored.page?.captureDigest).toMatch(/^[a-f0-9]{64}$/);
      const edit = await runtime.editBrowser({
        id: first.id,
        url: input.page.url,
        text: "Sibling browser edit",
        revision: browserNoteRevision(stored),
        authority: { deviceId: sibling.id, tokenId: update.id },
      });
      expect(edit.outcome).toBe("updated");
      expect((await service.capture(auth, input)).text).toContain("Sibling browser edit");
      await runtime.edit(first.id, "Portal editor's final thought");
      const retry = await service.capture(auth, input);
      expect(retry.text).toBe("Portal editor's final thought");
      expect(retry.page).toEqual(input.page);
      await expect(
        service.capture(auth, { ...input, text: "Changed original payload" }),
      ).rejects.toMatchObject({ status: 409 });
      expect(getNoteEntry(db, first.id)?.text).toBe("Portal editor's final thought");
      // A pending legacy capture can establish the digest before its first portal edit.
      const legacy = { ...input, id: randomUUID() };
      await runtime.capture({
        ...legacy,
        text: `${legacy.text}${browserNoteContext(legacy.page)}`,
        surface: "chrome-extension",
        deviceId: device.id,
      });
      await runtime.edit(legacy.id, "Legacy capture revised in portal");
      expect((await service.capture(auth, legacy)).text).toBe("Legacy capture revised in portal");
    } finally {
      await runtime.flushAll();
      runtime.dispose();
      db.close();
    }
  });

  test("page capture authority cannot create notes, and notes preserve explicit context", async () => {
    const f = fixture();
    const input = {
      id: randomUUID(),
      text: "Compare this approach.",
      page: {
        url: "https://example.org/article",
        title: "Example article",
        selection: "First line\nSecond line",
      },
    };
    await expect(f.service.capture(f.auth, input)).rejects.toThrow("notes:create");
    const note = await f.service.capture({ ...f.auth, scopes: [Scope("notes:create")] }, input);
    expect(note.text).toBe(
      "Compare this approach.\n\nPage: Example article — https://example.org/article\n\nSelected passage:\n> First line\n> Second line",
    );
    expect(note).toMatchObject({
      surface: "chrome-extension",
      deviceId: f.deviceId,
      page: input.page,
    });
  });
});
