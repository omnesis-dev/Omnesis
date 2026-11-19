// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { readPrivateJson } from "./google-credentials.js";
import { readBrokerMarker } from "./dns-broker-client.js";

vi.mock("./google-credentials.js", async (original) => ({
  ...(await original<typeof import("./google-credentials.js")>()),
  readPrivateJson: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

test.each([false, true])(
  "marked missing broker metadata never becomes absence (nested=%s)",
  async (nested) => {
    const marker = Object.assign(new Error("invented metadata cleanup uncertainty"), {
      cleanupFailure: undefined,
    });
    const error = Object.assign(
      nested ? new Error("invented read wrapper", { cause: marker }) : marker,
      {
        code: "ENOENT",
      },
    );
    vi.mocked(readPrivateJson).mockRejectedValue(error);
    await expect(readBrokerMarker("invented-broker-marker.json")).rejects.toBe(error);
    expect(readPrivateJson).toHaveBeenCalledOnce();
  },
);

test("ordinary missing broker metadata remains absence", async () => {
  vi.mocked(readPrivateJson).mockRejectedValue(
    Object.assign(new Error("invented missing marker"), { code: "ENOENT" }),
  );
  await expect(readBrokerMarker("invented-broker-marker.json")).resolves.toBeUndefined();
});

test("ordinary permission errors retain their original identity", async () => {
  const error = Object.assign(new Error("invented denied marker"), { code: "EACCES" });
  vi.mocked(readPrivateJson).mockRejectedValue(error);
  await expect(readBrokerMarker("invented-broker-marker.json")).rejects.toBe(error);
});

test("a valid account binding retains the broker contract", async () => {
  const marker = { claimedAt: 1, accountUri: "https://ca.example.test/acme/acct/42" };
  vi.mocked(readPrivateJson).mockResolvedValue(marker);
  await expect(readBrokerMarker("invented-broker-marker.json")).resolves.toEqual(marker);
});
