// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The stale-file-reference rule both adapters download through: refresh the
 * message once and retry, never more.
 */

import { describe, expect, it, vi } from "vitest";
import { downloadWithReferenceRefresh } from "./download.js";
import { TelegramError, type TgMessage } from "./types.js";

const BYTES = new TextEncoder().encode("Q4 budget review notes");

function stale(): TelegramError {
  return new TelegramError("file-reference-expired", "FILE_REFERENCE_EXPIRED", {
    rpc: "FILE_REFERENCE_EXPIRED",
  });
}

function freshMessage(fileId: string | undefined, size?: number): TgMessage {
  return {
    chatId: 5550100103,
    id: 7,
    box: "common",
    date: 1773133200,
    outgoing: false,
    text: "",
    media: {
      kind: "document",
      ...(fileId ? { fileId } : {}),
      fileName: "budget.txt",
      ...(size !== undefined ? { size } : {}),
      isViewOnce: false,
    },
  };
}

const TARGET = { chatId: 5550100103, msgId: 7, fileId: "old-ref" };

describe("downloadWithReferenceRefresh", () => {
  it("downloads by the stored file id without refetching when it is still good", async () => {
    const refetch = vi.fn();
    const result = await downloadWithReferenceRefresh(TARGET, 1000, {
      download: () => Promise.resolve(BYTES),
      refetch,
    });
    expect(result).toEqual({ data: BYTES });
    expect(refetch).not.toHaveBeenCalled();
  });

  it("refetches the message on a stale reference and retries once with its fresh file id", async () => {
    const download = vi.fn((fileId: string) =>
      fileId === "old-ref" ? Promise.reject(stale()) : Promise.resolve(BYTES),
    );
    const refetch = vi.fn(() => Promise.resolve(freshMessage("new-ref")));
    const result = await downloadWithReferenceRefresh(TARGET, 1000, { download, refetch });
    expect(download.mock.calls.map((c) => c[0])).toEqual(["old-ref", "new-ref"]);
    expect(refetch).toHaveBeenCalledWith(TARGET.chatId, TARGET.msgId);
    expect(result.data).toBe(BYTES);
    expect(result.refreshed).toMatchObject({ kind: "document", fileId: "new-ref" });
  });

  it("gives up after one refresh: a second stale answer is the caller's to retry later", async () => {
    const download = vi.fn(() => Promise.reject(stale()));
    await expect(
      downloadWithReferenceRefresh(TARGET, 1000, {
        download,
        refetch: () => Promise.resolve(freshMessage("new-ref")),
      }),
    ).rejects.toMatchObject({ code: "file-reference-expired" });
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("reports a message that is gone, or no longer has a file, as not found", async () => {
    for (const fresh of [null, freshMessage(undefined)]) {
      await expect(
        downloadWithReferenceRefresh(TARGET, 1000, {
          download: () => Promise.reject(stale()),
          refetch: () => Promise.resolve(fresh),
        }),
      ).rejects.toMatchObject({ code: "not-found" });
    }
  });

  it("refuses a file over the limit before fetching, and bytes over the limit after", async () => {
    const download = vi.fn(() => Promise.resolve(BYTES));
    await expect(
      downloadWithReferenceRefresh({ ...TARGET, size: 5000 }, 1000, { download, refetch: vi.fn() }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(download).not.toHaveBeenCalled();
    await expect(
      downloadWithReferenceRefresh(TARGET, 4, { download, refetch: vi.fn() }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("passes every other failure through untouched", async () => {
    const flood = new TelegramError("flood-wait", "FLOOD_WAIT_30", { seconds: 30 });
    const refetch = vi.fn();
    await expect(
      downloadWithReferenceRefresh(TARGET, 1000, {
        download: () => Promise.reject(flood),
        refetch,
      }),
    ).rejects.toBe(flood);
    expect(refetch).not.toHaveBeenCalled();
  });
});
