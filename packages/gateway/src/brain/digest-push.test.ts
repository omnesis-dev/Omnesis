// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { sendDigestPush } from "./digest-push.js";

test("sendDigestPush publishes the brief with a per-day collapse id", async () => {
  const publish = vi.fn(async () => []);
  await sendDigestPush(
    { publisher: { publish } },
    { id: "brief-example", title: "Morning brief", description: "A fictional digest." },
    "2026-07-02",
  );
  expect(publish).toHaveBeenCalledWith({
    kind: "brief",
    title: "Morning brief",
    body: "A fictional digest.",
    data: { briefId: "brief-example" },
    collapseId: "digest:2026-07-02",
  });
});
