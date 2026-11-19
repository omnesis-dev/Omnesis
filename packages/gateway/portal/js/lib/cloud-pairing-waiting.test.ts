// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { waitingCloudPairingRequests } from "./cloud-pairing-waiting.js";

test("only requests a person can still answer count as waiting", () => {
  const now = 1_000;
  const row = (status: string, expiresAt = now + 1) => ({ status, expiresAt });
  expect(
    waitingCloudPairingRequests(
      [row("pending"), row("approving"), row("approved"), row("denied"), row("pending", now), row("mystery"), null],
      now,
    ),
  ).toEqual([row("pending"), row("approving")]);
});

test("an answer without a list waits for nothing", () => {
  expect(waitingCloudPairingRequests(undefined, 1_000)).toEqual([]);
  expect(waitingCloudPairingRequests({ items: [] })).toEqual([]);
});

test("the current time is the default", () => {
  expect(waitingCloudPairingRequests([{ status: "pending", expiresAt: Date.now() + 60_000 }])).toHaveLength(1);
  expect(waitingCloudPairingRequests([{ status: "pending", expiresAt: Date.now() - 1 }])).toHaveLength(0);
});
