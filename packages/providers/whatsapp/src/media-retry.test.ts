// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, vi } from "vitest";
import { buildMediaRetryContext, classifyMediaDownloadError } from "./media-retry.js";

const fakeLogger = { info: vi.fn(), debug: vi.fn() } as never;

describe("buildMediaRetryContext", () => {
  test("returns a context whose reuploadRequest delegates to sock.updateMediaMessage", async () => {
    const updateMediaMessage = vi.fn(async (m: { key: { id: string } }) => ({
      ...m,
      refreshed: true,
    }));
    const ctx = buildMediaRetryContext({ updateMediaMessage } as never, fakeLogger);

    expect(ctx).toBeDefined();
    expect(ctx?.logger).toBe(fakeLogger);

    const msg = { key: { id: "voice-1" } } as never;
    const out = await ctx!.reuploadRequest(msg);
    expect(updateMediaMessage).toHaveBeenCalledWith(msg);
    expect(out).toMatchObject({ refreshed: true });
  });

  test("binds the socket as receiver so updateMediaMessage keeps its `this`", async () => {
    const sock = {
      marker: "the-socket",
      async updateMediaMessage(this: { marker: string }, m: unknown) {
        return { receiver: this.marker, m };
      },
    };
    const ctx = buildMediaRetryContext(sock as never, fakeLogger);
    const out = (await ctx!.reuploadRequest({ key: { id: "x" } } as never)) as unknown as {
      receiver: string;
    };
    expect(out.receiver).toBe("the-socket");
  });

  test("returns undefined when the socket can't re-request (pre-connect / test stub)", () => {
    expect(buildMediaRetryContext(null, fakeLogger)).toBeUndefined();
    expect(buildMediaRetryContext(undefined, fakeLogger)).toBeUndefined();
    expect(buildMediaRetryContext({} as never, fakeLogger)).toBeUndefined();
    expect(
      buildMediaRetryContext({ updateMediaMessage: undefined } as never, fakeLogger),
    ).toBeUndefined();
  });
});

describe("classifyMediaDownloadError", () => {
  test("treats 404/410/412 as terminal (gone from CDN/phone, or undecryptable)", () => {
    // Baileys surfaces media-retry results as a Boom with `.output.statusCode`.
    expect(classifyMediaDownloadError({ output: { statusCode: 404 } })).toBe("terminal");
    expect(classifyMediaDownloadError({ output: { statusCode: 410 } })).toBe("terminal");
    expect(classifyMediaDownloadError({ output: { statusCode: 412 } })).toBe("terminal");
    // Some errors carry statusCode directly.
    expect(classifyMediaDownloadError({ statusCode: 404 })).toBe("terminal");
  });

  test("recognizes the device re-upload failure messages as terminal", () => {
    expect(
      classifyMediaDownloadError(new Error("Media re-upload failed by device (NOT_FOUND)")),
    ).toBe("terminal");
    expect(classifyMediaDownloadError(new Error("media no longer available on phone"))).toBe(
      "terminal",
    );
    expect(
      classifyMediaDownloadError(new Error("Media re-upload failed by device (DECRYPTION_ERROR)")),
    ).toBe("terminal");
  });

  test("treats timeouts, network errors, and GENERAL_ERROR as transient", () => {
    expect(classifyMediaDownloadError(new Error("Timed out after 60000ms: media download x"))).toBe(
      "transient",
    );
    expect(classifyMediaDownloadError(new Error("socket hang up"))).toBe("transient");
    expect(classifyMediaDownloadError({ output: { statusCode: 418 } })).toBe("transient");
    expect(classifyMediaDownloadError("some string")).toBe("transient");
    expect(classifyMediaDownloadError(undefined)).toBe("transient");
  });
});
