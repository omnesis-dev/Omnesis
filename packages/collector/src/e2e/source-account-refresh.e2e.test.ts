// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { MultiCollectorHarness } from "./multi-collector-harness.js";

test("discovery metadata upgrades an existing source without changing its identity or cursor", async () => {
  const harness = new MultiCollectorHarness();
  try {
    await harness.start();
    const owner = await harness.addCollector({
      name: "owner",
      hostableSourceTypes: ["notes-synth"],
    });
    const stranger = await harness.addCollector({
      name: "stranger",
      hostableSourceTypes: ["notes-synth"],
    });
    const sourceId = "notes-synth:local";
    const send = (path: string, body: unknown, token = owner.token) =>
      fetch(`${harness.gatewayUrl}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const created = await send("/devices/sources/bulk-upsert", {
      sources: [{ type: "notes-synth", accountId: "local" }],
    });
    expect((await created.json()).errors).toEqual([]);
    const read = async () =>
      (
        await harness.json<{ items: Array<{ id: string; account: unknown }> }>("/admin/sources")
      ).items.find((row) => row.id === sourceId);
    await expect.poll(async () => (await read())?.account, { timeout: 10_000 }).toBeNull();
    expect(
      (await send(`/sync-state/${sourceId}`, { cursor: { bookmark: "retained" } })).status,
    ).toBe(200);
    const account = {
      id: "local",
      label: "Example notebook",
      subject: { kind: "opaque", value: "upstream-subject" },
      tenant: { id: "workspace-1" },
    };
    const refreshPath = `/sync-state/${sourceId}/meta`;
    expect((await send(refreshPath, { account, label: account.label })).status).toBe(200);
    await expect.poll(async () => (await read())?.account, { timeout: 10_000 }).toEqual(account);
    const state = await harness.json<{ cursor: unknown }>(`/sync-state/${sourceId}`);
    expect(state.cursor).toEqual({ bookmark: "retained" });
    expect((await send(refreshPath, { label: "Legacy display" })).status).toBe(200);
    expect((await read())?.account).toEqual(account);
    expect((await send(refreshPath, { account: { ...account, id: "different" } })).status).toBe(
      400,
    );
    expect(
      (await send(refreshPath, { account: { ...account, label: "Intrusion" } }, stranger.token))
        .status,
    ).toBe(403);
    expect((await read())?.account).toEqual(account);
  } finally {
    await harness.destroy();
  }
}, 60_000);
