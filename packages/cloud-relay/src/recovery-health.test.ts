// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { recoveryFixture } from "../test/recovery-fixture.js";
import { listen } from "../test/support.js";
import { createCloudRelay } from "./server.js";
import { RelayAccounts } from "./accounts.js";
import { RelaySessions } from "./identity.js";

test("relay health reports an expired independent policy before accepting another owner connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-recovery-health-"));
  const accounts = new RelayAccounts(":memory:");
  let relay: ReturnType<typeof createCloudRelay> | undefined;
  try {
    const f = await recoveryFixture(directory),
      policy = f.policy();
    relay = createCloudRelay({
      accounts,
      sessions: new RelaySessions(randomBytes(32)),
      recoveryPolicy: policy,
    });
    const url = await listen(relay.server);
    const healthy = await fetch(`${url}/healthz`);
    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({
      ok: true,
      protocol: 2,
      recovery: { epoch: policy.epoch, expiresAt: policy.expiresAt, state: "current" },
    });
    vi.spyOn(Date, "now").mockReturnValue((policy.expiresAt + 1) * 1000);
    const expired = await fetch(`${url}/healthz`);
    expect(expired.status).toBe(503);
    expect(await expired.json()).toEqual({
      ok: false,
      protocol: 2,
      recovery: { epoch: policy.epoch, expiresAt: policy.expiresAt, state: "expired" },
    });
  } finally {
    vi.restoreAllMocks();
    await relay?.close();
    accounts.close();
    await rm(directory, { recursive: true, force: true });
  }
});
