// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Multi-collector disambiguation E2E.
 *
 * Exercises the disambiguation surface end-to-end against two paired
 * pseudo-collectors:
 *
 *   - `GET  /admin/source-descriptors`  union across collectors
 *   - `POST /admin/sources/add`         capability-aware device routing
 *   - `POST /admin/sources/reauth-finalize`  account-aware device routing
 *   - `cli sources add` from a subprocess (verifies the --device flag and
 *     the structured error path when ambiguous)
 *
 * The harness itself lives in `multi-collector-harness.ts` so the
 * multi-account suite can share it.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { MultiCollectorHarness } from "./multi-collector-harness.js";

// ─────────────────────────────────────────────────────────────────────────────

describe("multi-collector disambiguation (gateway)", () => {
  let harness: MultiCollectorHarness;

  // Source-type matrix:
  //   gmail-synth      — hosted by BOTH (ambiguous case)
  //   calendar-synth   — hosted by macbook only
  //   notion-synth     — hosted by linuxbox only
  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    await harness.addCollector({
      name: "macbook",
      hostableSourceTypes: ["gmail-synth", "calendar-synth"],
    });
    await harness.addCollector({
      name: "linuxbox",
      hostableSourceTypes: ["gmail-synth", "notion-synth"],
    });
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("GET /admin/devices reports both collectors online with hostname", async () => {
    const { items } = await harness.json<{
      items: Array<{ name: string; online: boolean; capabilities?: { hostname?: string } }>;
    }>("/admin/devices");
    const macbook = items.find((d) => d.name === "macbook");
    const linuxbox = items.find((d) => d.name === "linuxbox");
    expect(macbook?.online).toBe(true);
    expect(linuxbox?.online).toBe(true);
    expect(macbook?.capabilities?.hostname).toBe("macbook.example.com");
    expect(linuxbox?.capabilities?.hostname).toBe("linuxbox.example.com");
  });

  test("GET /admin/source-descriptors unions across collectors with per-source device list", async () => {
    const { items } = await harness.json<{
      items: Array<{ id: string; devices: Array<{ name: string }> }>;
    }>("/admin/source-descriptors");
    const gmail = items.find((d) => d.id === "gmail-synth");
    const calendar = items.find((d) => d.id === "calendar-synth");
    const notion = items.find((d) => d.id === "notion-synth");
    expect(gmail).toBeDefined();
    expect(calendar).toBeDefined();
    expect(notion).toBeDefined();
    expect(gmail!.devices.map((d) => d.name).sort()).toEqual(["linuxbox", "macbook"]);
    expect(calendar!.devices.map((d) => d.name)).toEqual(["macbook"]);
    expect(notion!.devices.map((d) => d.name)).toEqual(["linuxbox"]);
  });

  test("POST /admin/sources/add with ambiguous source returns structured 400 + device list", async () => {
    try {
      await harness.json("/admin/sources/add", {
        method: "POST",
        body: JSON.stringify({ descriptorId: "gmail-synth", accountIds: ["alice@example.com"] }),
      });
      throw new Error("expected 400 but got success");
    } catch (err) {
      const e = err as {
        status?: number;
        body?: { code?: string; devices?: Array<{ name: string }> };
      };
      expect(e.status).toBe(400);
      expect(e.body?.code).toBe("AMBIGUOUS_DEVICE");
      expect((e.body?.devices ?? []).map((d) => d.name).sort()).toEqual(["linuxbox", "macbook"]);
    }
  });

  test("POST /admin/sources/add auto-picks the only capable device", async () => {
    // notion-synth is only on linuxbox — no deviceId required.
    const result = await harness.json<{ deviceId: string; sourceIds: string[] }>(
      "/admin/sources/add",
      {
        method: "POST",
        body: JSON.stringify({ descriptorId: "notion-synth", accountIds: ["auto"] }),
      },
    );
    const linuxbox = harness.collectors.find((c) => c.name === "linuxbox");
    expect(result.deviceId).toBe(linuxbox!.deviceId);
    expect(result.sourceIds).toEqual(["notion-synth:auto"]);
  });

  test("POST /admin/sources/add honours explicit deviceId", async () => {
    const macbook = harness.collectors.find((c) => c.name === "macbook")!;
    const result = await harness.json<{ deviceId: string; sourceIds: string[] }>(
      "/admin/sources/add",
      {
        method: "POST",
        body: JSON.stringify({
          deviceId: macbook.deviceId,
          descriptorId: "gmail-synth",
          accountIds: ["mac-only@example.com"],
        }),
      },
    );
    expect(result.deviceId).toBe(macbook.deviceId);
    // Verify it landed on macbook (device_id on the new source row).
    const { items } = await harness.json<{
      items: Array<{ id: string; deviceId: string }>;
    }>(`/admin/sources?deviceId=${macbook.deviceId}`);
    expect(items.some((s) => s.id === "gmail-synth:mac-only@example.com")).toBe(true);
  });

  test("POST /admin/sources/:id/sync accepts the collector's numeric acknowledgement", async () => {
    const macbook = harness.collectors.find((c) => c.name === "macbook")!;
    const sourceId = "calendar-synth:sync-test";
    await harness.json("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        deviceId: macbook.deviceId,
        type: "calendar-synth",
        accountId: "sync-test",
      }),
    });

    const response = await harness.json<{
      ok: boolean;
      deviceId: string;
      result: { ok: boolean; triggered: number };
    }>(`/admin/sources/${encodeURIComponent(sourceId)}/sync`, { method: "POST" });

    expect(response).toEqual({
      ok: true,
      deviceId: macbook.deviceId,
      result: { ok: true, triggered: 1 },
    });
    expect(macbook.receivedCommands).toContainEqual({
      type: "source.sync",
      payload: { sourceId },
    });
  });

  test("POST /admin/sources/:id/sync rejects a negative collector acknowledgement", async () => {
    const macbook = harness.collectors.find((c) => c.name === "macbook")!;
    const sourceId = "calendar-synth:rejected-sync";
    await harness.json("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        deviceId: macbook.deviceId,
        type: "calendar-synth",
        accountId: "rejected-sync",
      }),
    });

    macbook.sourceSyncResponse = {
      ok: false,
      triggered: 0,
      skipped: 0,
      disabled: 0,
      error: `No sources match: ${sourceId}`,
    };
    try {
      await harness.json(`/admin/sources/${encodeURIComponent(sourceId)}/sync`, {
        method: "POST",
      });
      throw new Error("expected 502 but got success");
    } catch (err) {
      const e = err as { status?: number; body?: { error?: string; code?: string } };
      expect(e.status).toBe(502);
      expect(e.body?.code).toBe("BAD_GATEWAY");
      expect(e.body?.error).toBe(`No sources match: ${sourceId}`);
    } finally {
      macbook.sourceSyncResponse = { ok: true, triggered: 1 };
    }
  });

  test("POST /admin/sources/:id/resync asks the host to restart and reports what it did with that", async () => {
    const macbook = harness.collectors.find((c) => c.name === "macbook")!;
    const sourceId = "calendar-synth:resync-verdicts";
    await harness.json("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        deviceId: macbook.deviceId,
        type: "calendar-synth",
        accountId: "resync-verdicts",
      }),
    });
    const resync = () =>
      harness.json<{
        ok: boolean;
        scope: string;
        deviceIds: string[];
        restarting: string[];
        skipped: string[];
      }>(`/admin/sources/${encodeURIComponent(sourceId)}/resync`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    try {
      // A host that started the sync is counted as reached; the command it
      // took carried the restart.
      macbook.receivedCommands.length = 0;
      expect(await resync()).toEqual({
        ok: true,
        scope: "source",
        deviceIds: [macbook.deviceId],
        restarting: [],
        disabled: [],
        skipped: [],
      });
      expect(macbook.receivedCommands).toContainEqual({
        type: "source.sync",
        payload: { sourceId, restart: true },
      });

      // A host that answers as a collector predating the restart flag does
      // for a source mid-sync — accepted, nothing started — is reported as
      // skipped, not as sent.
      macbook.sourceSyncResponse = { ok: true, triggered: 0, skipped: 1, disabled: 0 };
      expect(await resync()).toEqual({
        ok: true,
        scope: "source",
        deviceIds: [],
        restarting: [],
        disabled: [],
        skipped: [macbook.deviceId],
      });

      // A host on which the source is paused reports it as disabled: the
      // wipe already happened and nothing re-fetches until the source resumes.
      macbook.sourceSyncResponse = { ok: true, triggered: 0, skipped: 0, disabled: 1 };
      expect(await resync()).toEqual({
        ok: true,
        scope: "source",
        deviceIds: [],
        restarting: [],
        disabled: [macbook.deviceId],
        skipped: [],
      });

      // A host that aborted the run it had in flight is restarting.
      macbook.sourceSyncResponse = { ok: true, triggered: 0, skipped: 0, restarting: 1 };
      expect(await resync()).toEqual({
        ok: true,
        scope: "source",
        deviceIds: [],
        restarting: [macbook.deviceId],
        disabled: [],
        skipped: [],
      });
    } finally {
      macbook.sourceSyncResponse = { ok: true, triggered: 1 };
    }
  });

  test("a push under a device's scoped token self-registers the source to that device", async () => {
    const macbook = harness.collectors.find((c) => c.name === "macbook")!;
    // A `write:<type>` token is what a push-only client carries: the gateway
    // registers an unknown source to the token's device on first ingest.
    const { token } = await harness.json<{ token: string }>("/admin/tokens", {
      method: "POST",
      body: JSON.stringify({
        deviceId: macbook.deviceId,
        scopes: ["write:calendar-synth"],
        name: "calendar pusher",
      }),
    });
    const sourceId = "calendar-synth:pushed@example.com";
    const pushed = await harness.pushDocuments(
      macbook,
      [{ sourceId, externalId: "evt-1", title: "Roster sync", content: "Devices meet at noon." }],
      { token },
    );
    expect(pushed.ingested).toBe(1);

    const { source } = await harness.json<{ source: { deviceId: string } }>(
      `/admin/sources/${encodeURIComponent(sourceId)}`,
    );
    expect(source.deviceId).toBe(macbook.deviceId);
    const { count } = await harness.json<{ count: number }>(
      `/documents/count/${encodeURIComponent(sourceId)}`,
    );
    expect(count).toBe(1);

    // The device token itself holds `write:*`, which never self-registers:
    // a push for an unregistered source under it leaves no row behind.
    const orphan = "calendar-synth:orphan@example.com";
    await harness.pushDocuments(macbook, [{ sourceId: orphan, externalId: "evt-2" }]);
    await expect(
      harness.json(`/admin/sources/${encodeURIComponent(orphan)}`),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("POST /admin/sources/add rejects DEVICE_CANNOT_HOST_TYPE on capability mismatch", async () => {
    const macbook = harness.collectors.find((c) => c.name === "macbook")!;
    try {
      await harness.json("/admin/sources/add", {
        method: "POST",
        body: JSON.stringify({
          deviceId: macbook.deviceId,
          descriptorId: "notion-synth",
          accountIds: ["nope"],
        }),
      });
      throw new Error("expected 400 but got success");
    } catch (err) {
      const e = err as { status?: number; body?: { code?: string; sourceType?: string } };
      expect(e.status).toBe(400);
      expect(e.body?.code).toBe("DEVICE_CANNOT_HOST_TYPE");
      expect(e.body?.sourceType).toBe("notion-synth");
    }
  });

  test("POST /admin/sources/add returns NO_CAPABLE_DEVICE for a source no collector hosts", async () => {
    try {
      await harness.json("/admin/sources/add", {
        method: "POST",
        body: JSON.stringify({ descriptorId: "strava-synth", accountIds: ["x"] }),
      });
      throw new Error("expected 400 but got success");
    } catch (err) {
      const e = err as {
        status?: number;
        body?: { code?: string; sourceType?: string; online?: Array<{ name: string }> };
      };
      expect(e.status).toBe(400);
      expect(e.body?.code).toBe("NO_CAPABLE_DEVICE");
      expect(e.body?.sourceType).toBe("strava-synth");
      // The `online` field enumerates the candidates the gateway considered
      // (and rejected) so the client can render a helpful message.
      const names = (e.body?.online ?? []).map((d) => d.name).sort();
      expect(names).toEqual(["linuxbox", "macbook"]);
    }
  });

  test("POST /admin/sources/add rejects DEVICE_NOT_FOUND for an unknown UUID", async () => {
    try {
      await harness.json("/admin/sources/add", {
        method: "POST",
        body: JSON.stringify({
          deviceId: "00000000-0000-4000-8000-000000000000",
          descriptorId: "gmail-synth",
          accountIds: ["x"],
        }),
      });
      throw new Error("expected 404 but got success");
    } catch (err) {
      const e = err as { status?: number; body?: { code?: string } };
      expect(e.status).toBe(404);
      expect(e.body?.code).toBe("DEVICE_NOT_FOUND");
    }
  });

  test("POST /admin/sources/add rejects DEVICE_NOT_FOUND for a malformed deviceId", async () => {
    try {
      await harness.json("/admin/sources/add", {
        method: "POST",
        body: JSON.stringify({
          deviceId: "not-a-uuid",
          descriptorId: "gmail-synth",
          accountIds: ["x"],
        }),
      });
      throw new Error("expected 404 but got success");
    } catch (err) {
      const e = err as { status?: number; body?: { code?: string } };
      expect(e.status).toBe(404);
      expect(e.body?.code).toBe("DEVICE_NOT_FOUND");
    }
  });

  test("POST /admin/sources/add rejects DEVICE_NOT_COLLECTOR for a non-collector device", async () => {
    // Pair a CLI-kind device, then try to dispatch a source to it.
    const cliDev = (
      await harness.json<{ device: { id: string } }>("/admin/devices", {
        method: "POST",
        body: JSON.stringify({ name: "fake-cli", kind: "cli", scopes: ["admin"] }),
      })
    ).device;
    try {
      await harness.json("/admin/sources/add", {
        method: "POST",
        body: JSON.stringify({
          deviceId: cliDev.id,
          descriptorId: "gmail-synth",
          accountIds: ["x"],
        }),
      });
      throw new Error("expected 404 but got success");
    } catch (err) {
      const e = err as { status?: number; body?: { code?: string } };
      expect(e.status).toBe(404);
      expect(e.body?.code).toBe("DEVICE_NOT_COLLECTOR");
    }
  });

  test("POST /admin/sources/reauth-finalize returns NO_MATCHING_SOURCE when no source matches the account", async () => {
    try {
      await harness.json("/admin/sources/reauth-finalize", {
        method: "POST",
        body: JSON.stringify({
          providerType: "gmail-synth-provider",
          accountId: "nobody@nowhere.test",
        }),
      });
      throw new Error("expected 400 but got success");
    } catch (err) {
      const e = err as { status?: number; body?: { code?: string; accountId?: string } };
      expect(e.status).toBe(400);
      expect(e.body?.code).toBe("NO_MATCHING_SOURCE");
      expect(e.body?.accountId).toBe("nobody@nowhere.test");
    }
  });

  test("POST /admin/sources/reauth-finalize returns AMBIGUOUS_DEVICE when the same account spans both collectors", async () => {
    // makeSourceId is `${type}:${accountId}`, so two rows with the same
    // type+account would just re-home (createSource is idempotent on id).
    // Seed two different source types under the same accountId — one only
    // macbook can host (calendar-synth), one only linuxbox can host
    // (notion-synth). That gives the reauth resolver two distinct source
    // rows on different devices for one account, which is the production
    // shape for a real ambiguous reauth.
    const macbook = harness.collectors.find((c) => c.name === "macbook")!;
    const linuxbox = harness.collectors.find((c) => c.name === "linuxbox")!;
    await harness.json("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        deviceId: macbook.deviceId,
        type: "calendar-synth",
        accountId: "shared@example.com",
      }),
    });
    await harness.json("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        deviceId: linuxbox.deviceId,
        type: "notion-synth",
        accountId: "shared@example.com",
      }),
    });
    try {
      await harness.json("/admin/sources/reauth-finalize", {
        method: "POST",
        body: JSON.stringify({
          // providerType is opaque to the gateway resolver — it routes by
          // accountId. Use any plausible value.
          providerType: "calendar-synth-provider",
          accountId: "shared@example.com",
        }),
      });
      throw new Error("expected 400 but got success");
    } catch (err) {
      const e = err as {
        status?: number;
        body?: { code?: string; devices?: Array<{ name: string }> };
      };
      expect(e.status).toBe(400);
      expect(e.body?.code).toBe("AMBIGUOUS_DEVICE");
      expect((e.body?.devices ?? []).map((d) => d.name).sort()).toEqual(["linuxbox", "macbook"]);
    }
  });

  test("POST /admin/sources/reauth-finalize rejects explicit device that doesn't host the account", async () => {
    // macbook hosts gmail-synth:mac-only@example.com (seeded earlier in this
    // describe block via the explicit-deviceId test). Try to reauth that
    // account but explicitly target linuxbox.
    const linuxbox = harness.collectors.find((c) => c.name === "linuxbox")!;
    try {
      await harness.json("/admin/sources/reauth-finalize", {
        method: "POST",
        body: JSON.stringify({
          deviceId: linuxbox.deviceId,
          providerType: "gmail-synth-provider",
          accountId: "mac-only@example.com",
        }),
      });
      throw new Error("expected 400 but got success");
    } catch (err) {
      const e = err as { status?: number; body?: { code?: string } };
      expect(e.status).toBe(400);
      expect(e.body?.code).toBe("NO_MATCHING_SOURCE");
    }
  });

  test("POST /admin/sources/reauth-finalize routes by accountId to the owning device", async () => {
    // Seed: gmail-synth:linux-account on linuxbox via direct admin POST.
    const linuxbox = harness.collectors.find((c) => c.name === "linuxbox")!;
    await harness.json("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        deviceId: linuxbox.deviceId,
        type: "gmail-synth",
        accountId: "linux-account@example.com",
      }),
    });
    // Reauth without deviceId — the gateway must route to linuxbox.
    // Reset the command logs so the routing assertion below isn't
    // contaminated by source.descriptors / source.add traffic from
    // earlier tests in this describe block.
    linuxbox.receivedCommands.length = 0;
    const macbook = harness.collectors.find((c) => c.name === "macbook")!;
    macbook.receivedCommands.length = 0;
    const result = await harness.json<{ deviceId: string }>("/admin/sources/reauth-finalize", {
      method: "POST",
      body: JSON.stringify({
        providerType: "gmail-synth-provider",
        accountId: "linux-account@example.com",
      }),
    });
    expect(result.deviceId).toBe(linuxbox.deviceId);
    expect(linuxbox.receivedCommands.some((c) => c.type === "source.reauth-finalize")).toBe(true);
    expect(macbook.receivedCommands.some((c) => c.type === "source.reauth-finalize")).toBe(false);
  });
});

describe("multi-collector CLI surface", () => {
  let harness: MultiCollectorHarness;

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    await harness.addCollector({
      name: "macbook",
      hostableSourceTypes: ["gmail-synth", "calendar-synth"],
    });
    await harness.addCollector({
      name: "linuxbox",
      hostableSourceTypes: ["gmail-synth", "notion-synth"],
    });
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("`omnesis devices list` shows hostname column for each collector", async () => {
    const r = await harness.runCli(["devices", "list"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("HOSTNAME");
    expect(r.stdout).toContain("macbook.example.com");
    expect(r.stdout).toContain("linuxbox.example.com");
  });

  test("`omnesis sources add gmail-synth` (no --device) exits non-zero on ambiguity", async () => {
    // execFile-spawned children have no controlling TTY, so isInteractive()
    // returns false. pickDeviceForDescriptor sees devices.length > 1 + no
    // TTY → throws CliError listing both candidate names.
    const r = await harness.runCli(["sources", "add", "gmail-synth"], { timeoutMs: 20_000 });
    expect(r.exitCode).not.toBe(0);
    const combined = `${r.stdout}\n${r.stderr}`;
    expect(combined).toContain("macbook");
    expect(combined).toContain("linuxbox");
  });

  test("`omnesis sources add gmail-synth --device unknown` errors with a helpful message", async () => {
    const r = await harness.runCli(
      ["sources", "add", "gmail-synth", "--device", "ghost-device-name"],
      { timeoutMs: 20_000 },
    );
    expect(r.exitCode).not.toBe(0);
    const combined = `${r.stdout}\n${r.stderr}`;
    expect(combined.toLowerCase()).toMatch(/no device|ghost-device-name/);
  });

  test("`omnesis sources add gmail-synth --device macbook` succeeds", async () => {
    const r = await harness.runCli(["sources", "add", "gmail-synth", "--device", "macbook"], {
      timeoutMs: 30_000,
    });
    expect(r.exitCode, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("added successfully");
    // Confirm the source landed on macbook (not linuxbox).
    const macbook = harness.collectors.find((c) => c.name === "macbook")!;
    const { items } = await harness.json<{
      items: Array<{ id: string; deviceId: string }>;
    }>(`/admin/sources?deviceId=${macbook.deviceId}`);
    expect(items.some((s) => s.type === "gmail-synth")).toBe(true);
  });

  test("`omnesis sources add notion-synth` (no --device) auto-picks linuxbox", async () => {
    // Only one collector hosts notion-synth so the picker is a no-op in
    // both TTY and non-TTY modes. Descriptor has no params, authType=local,
    // pushBased=true → no prompts after the descriptor pick.
    const r = await harness.runCli(["sources", "add", "notion-synth"], { timeoutMs: 30_000 });
    expect(r.exitCode, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("added successfully");
    const linuxbox = harness.collectors.find((c) => c.name === "linuxbox")!;
    const { items } = await harness.json<{
      items: Array<{ id: string; deviceId: string }>;
    }>(`/admin/sources?deviceId=${linuxbox.deviceId}`);
    expect(items.some((s) => s.type === "notion-synth")).toBe(true);
  });
});

describe("resync of a push-only source (gateway)", () => {
  let harness: MultiCollectorHarness;

  // A collector whose one hosted type is push-based: its `sync()` is inert
  // and an external runtime pushes the data, as the real collector announces
  // for such a descriptor.
  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    await harness.addCollector({
      name: "runtime-host",
      hostableSourceTypes: ["transcript-synth"],
      pushBasedSourceTypes: ["transcript-synth"],
    });
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("POST /admin/sources/:id/resync refuses a source whose data only arrives by push, deleting nothing", async () => {
    const runtime = harness.collectors.find((c) => c.name === "runtime-host")!;
    const sourceId = "transcript-synth:pushed";
    await harness.json("/admin/sources", {
      method: "POST",
      body: JSON.stringify({
        deviceId: runtime.deviceId,
        type: "transcript-synth",
        accountId: "pushed",
      }),
    });
    await harness.pushDocuments(runtime, [
      {
        sourceId,
        externalId: "session-1",
        title: "Pushed session",
        content: "a transcript an external runtime pushed",
      },
    ]);
    const count = async () =>
      (
        await harness.json<{ stats: Record<string, { documentCount: number }> }>(
          "/documents/stats",
          { method: "POST", body: JSON.stringify({ sourceIds: [sourceId] }) },
        )
      ).stats[sourceId]?.documentCount ?? 0;
    expect(await count()).toBe(1);
    runtime.receivedCommands.length = 0;

    try {
      await harness.json(`/admin/sources/${encodeURIComponent(sourceId)}/resync`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      throw new Error("expected 400 but got success");
    } catch (err) {
      const e = err as { status?: number; body?: { code?: string; error?: string } };
      expect(e.status).toBe(400);
      expect(e.body?.code).toBe("RESYNC_PUSH_ONLY");
      expect(e.body?.error).toContain("there is nothing to fetch it again from");
    }
    expect(await count(), "nothing was deleted").toBe(1);
    expect(runtime.receivedCommands.some((cmd) => cmd.type === "source.sync")).toBe(false);
  });
});
