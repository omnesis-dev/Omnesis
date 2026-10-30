// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { TelegramError } from "./client/types.js";
import { MEDIA_MAX_ATTEMPTS } from "./limits.js";
import {
  backoffStep,
  classifyDownloadFailure,
  downloadRetryDelaySec,
  isProcessableKind,
} from "./media-retry.js";

describe("media retry rules", () => {
  it("steps through the backoff, repeats the last step, and gives a download up at the cap", () => {
    expect([1, 2, 3, 7, 9].map(backoffStep)).toEqual([20, 60, 300, 43_200, 43_200]);
    expect(downloadRetryDelaySec(MEDIA_MAX_ATTEMPTS - 1)).toBe(43_200);
    expect(downloadRetryDelaySec(MEDIA_MAX_ATTEMPTS)).toBeNull();
  });

  it("downloads only voice notes, photos and documents", () => {
    expect(["voice", "photo", "document"].every((k) => isProcessableKind(k as never))).toBe(true);
    for (const kind of ["audio", "video", "video_note", "sticker", "animation"] as const) {
      expect(isProcessableKind(kind)).toBe(false);
    }
  });

  it("classifies every download failure", () => {
    const err = (code: ConstructorParameters<typeof TelegramError>[0], seconds?: number) =>
      new TelegramError(code, code, seconds !== undefined ? { seconds } : undefined);
    expect(classifyDownloadFailure(err("flood-wait", 42))).toMatchObject({
      kind: "flood",
      seconds: 42,
    });
    expect(classifyDownloadFailure(err("not-found")).kind).toBe("terminal");
    expect(classifyDownloadFailure(err("forbidden")).kind).toBe("terminal");
    expect(classifyDownloadFailure(err("revoked")).kind).toBe("halt");
    for (const code of ["network", "unknown", "file-reference-expired", "cancelled"] as const) {
      expect(classifyDownloadFailure(err(code)).kind).toBe("transient");
    }
    expect(classifyDownloadFailure(new Error("socket hang up")).kind).toBe("transient");
    const aborted = new AbortController();
    aborted.abort();
    expect(classifyDownloadFailure(err("network"), aborted.signal).kind).toBe("cancelled");
  });
});
