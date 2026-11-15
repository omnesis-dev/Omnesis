// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, expect, test, vi } from "vitest";
const { readKey, required } = vi.hoisted(() => ({ readKey: vi.fn(), required: vi.fn() }));
vi.mock("@omnesis/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omnesis/core")>()),
  readStorageKeySync: readKey,
  storageEncryptionRequired: required,
}));
import { readTelegramStoreKey, StoreKeyUnavailableError } from "./protected-store.js";

beforeEach(() => {
  readKey.mockReset();
  required.mockReset().mockReturnValue(false);
});

test.each([false, true])(
  "a live store key read preserves explicit cleanup uncertainty (nested=%s)",
  (nested) => {
    const cause = Object.assign(new Error("invented key cleanup uncertainty"), {
      cleanupFailure: undefined,
    });
    const error = nested ? new Error("invented wrapper", { cause }) : cause;
    readKey.mockImplementation(() => {
      throw error;
    });
    try {
      readTelegramStoreKey("invented-config");
      expect.unreachable("Expected the original marked key error");
    } catch (caught) {
      expect(caught).toBe(error);
    }
    expect(required).not.toHaveBeenCalled();
  },
);

test("an ordinary joined key error retains the actionable domain failure", () => {
  readKey.mockImplementation(() => {
    throw Object.assign(new Error("invented unavailable key"), { code: "EACCES" });
  });
  expect(() => readTelegramStoreKey("invented-config")).toThrow(StoreKeyUnavailableError);
  expect(() => readTelegramStoreKey("invented-config")).toThrow("invented unavailable key");
  expect(required).not.toHaveBeenCalled();
});

test("an optional missing key remains unencrypted and a required missing key stays refused", () => {
  readKey.mockReturnValue(null);
  expect(readTelegramStoreKey("invented-config")).toBeNull();
  required.mockReturnValue(true);
  expect(() => readTelegramStoreKey("invented-config")).toThrow(StoreKeyUnavailableError);
});
