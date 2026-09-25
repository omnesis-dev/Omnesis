// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { accountStateDir, buildProviderHost, buildSourceHost } from "./source-host-builder.js";
import type { GatewayClient } from "@omnesis/source-sdk";

function tempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "omnesis-host-"));
}

const inputs = (configDir: string) => ({
  providerBaseId: "acme",
  accountId: "person@example.com",
  configDir,
});

describe("the account state directory", () => {
  it("is the layout that already exists on disk, so nothing has to move", () => {
    expect(
      accountStateDir({
        providerBaseId: "acme",
        accountId: "person@example.com",
        configDir: "/cfg",
      }),
    ).toBe("/cfg/acme/person@example.com");
  });

  it("refuses a path-shaped account rather than escaping the config root", () => {
    // The account id is a directory name, so a traversal segment here would
    // redirect a credential read outside the provider's own tree.
    expect(() =>
      accountStateDir({ providerBaseId: "acme", accountId: "../../etc", configDir: "/cfg" }),
    ).toThrow();
  });

  it("refuses a path-shaped provider id too", () => {
    expect(() =>
      accountStateDir({ providerBaseId: "../acme", accountId: "local", configDir: "/cfg" }),
    ).toThrow();
  });
});

describe("what a source is lent", () => {
  it("creates its state directory before handing it over, so a source can write immediately", () => {
    const configDir = tempConfigDir();
    try {
      const host = buildSourceHost({
        ...inputs(configDir),
        sourceId: "acme-mail:person@example.com",
        sourceType: "acme-mail",
        declaresAnalytics: false,
      });
      expect(host.stateDir).toBe(join(configDir, "acme", "person@example.com"));
      expect(existsSync(host.stateDir)).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("still instantiates when the directory cannot be created", () => {
    // A source that keeps no local store does not care, and one that does will
    // fail with its own specific message when it writes. Refusing here would
    // take down sources that never touch the directory.
    const dir = tempConfigDir();
    try {
      // A regular file where a directory belongs: mkdir fails immediately.
      const blocked = join(dir, "blocked");
      writeFileSync(blocked, "not a directory");
      const host = buildSourceHost({
        providerBaseId: "acme",
        accountId: "local",
        configDir: blocked,
        sourceId: "acme-mail:local",
        sourceType: "acme-mail",
        declaresAnalytics: false,
      });
      expect(host.stateDir).toContain("acme");
      expect(existsSync(host.stateDir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has an injectable clock rather than reading the global one", () => {
    const host = buildProviderHost(inputs("/cfg"));
    const before = Date.now();
    expect(host.now().getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("analytics scope", () => {
  function gatewaySpy() {
    const ingested: unknown[][] = [];
    const queried: unknown[][] = [];
    const gateway = {
      queryAnalytics: (...args: unknown[]) => {
        queried.push(args);
        return Promise.resolve({ columns: [], rows: [] });
      },
      ingestAnalyticsPage: (...args: unknown[]) => {
        ingested.push(args);
        return Promise.resolve({ ingested: 1 });
      },
    } as unknown as GatewayClient;
    return { gateway, ingested, queried };
  }

  it("is absent for a source that declares no tables", () => {
    const host = buildSourceHost({
      ...inputs("/cfg"),
      sourceId: "acme-mail:local",
      sourceType: "acme-mail",
      gateway: gatewaySpy().gateway,
      declaresAnalytics: false,
    });
    // Handing a documents-only source a query facet would be the same
    // over-provisioning this change exists to remove, one scale down.
    expect(host.analytics).toBeUndefined();
  });

  it("is present for a source that declares tables, including an empty dynamic set", () => {
    // An empty array is a real declaration: the tables exist, their columns are
    // discovered at runtime.
    const host = buildSourceHost({
      ...inputs("/cfg"),
      sourceId: "acme-rows:local",
      sourceType: "acme-rows",
      gateway: gatewaySpy().gateway,
      declaresAnalytics: true,
    });
    expect(host.analytics).toBeDefined();
  });

  it("offers a source no way to write, because writing is what a page is for", () => {
    const { gateway, ingested } = gatewaySpy();
    const host = buildSourceHost({
      ...inputs("/cfg"),
      sourceId: "acme-rows:person@example.com",
      sourceType: "acme-rows",
      gateway,
      declaresAnalytics: true,
    });
    // A write from inside a source would skip the cursor that covers it, the
    // write epoch that fences it and the lease that authorises it. The client
    // underneath can still ingest — the point is that nothing a source holds
    // reaches that method.
    expect("ingest" in host.analytics!).toBe(false);
    expect(ingested).toEqual([]);
  });

  it("passes a query through with its limit", async () => {
    const { gateway, queried } = gatewaySpy();
    const host = buildSourceHost({
      ...inputs("/cfg"),
      sourceId: "acme-rows:local",
      sourceType: "acme-rows",
      gateway,
      declaresAnalytics: true,
    });
    await host.analytics!.query("SELECT 1", { limit: 50 });
    // The source id rides along and is supplied here, not by the source: a
    // source hands over SQL and cannot say whose tables to read it against.
    expect(queried[0]).toEqual(["SELECT 1", 50, "acme-rows:local"]);
  });

  it("exposes nothing beyond the one analytics operation", () => {
    const host = buildSourceHost({
      ...inputs("/cfg"),
      sourceId: "acme-rows:local",
      sourceType: "acme-rows",
      gateway: gatewaySpy().gateway,
      declaresAnalytics: true,
    });
    // The client this wraps can search every document and delete a whole
    // provider's. None of that reaches a source.
    expect(Object.keys(host.analytics!).sort()).toEqual(["query"]);
    expect((host as unknown as Record<string, unknown>).gateway).toBeUndefined();
    expect((host as unknown as Record<string, unknown>).config).toBeUndefined();
  });
});

describe("audio routing", () => {
  it("defaults to excluding audio types", () => {
    const host = buildSourceHost({
      ...inputs("/cfg"),
      sourceId: "acme-mail:local",
      sourceType: "acme-mail",
      declaresAnalytics: false,
    });
    expect(host.includeAudioTypes).toBe(false);
  });

  it("is not offered to a provider context, which has no source to route for", () => {
    // Transcription and the audio allow-list are decided per source, so an
    // account-scoped host that carried them would be answering for whichever
    // of its sources happened to ask first.
    const host = buildProviderHost(inputs("/cfg")) as unknown as Record<string, unknown>;
    expect(host.includeAudioTypes).toBeUndefined();
    expect(host.transcribeAudio).toBeUndefined();
  });

  it("carries the routing the collector decided", () => {
    const transcribeAudio = vi.fn();
    const host = buildSourceHost({
      ...inputs("/cfg"),
      transcribeAudio,
      includeAudioTypes: false,
      sourceId: "acme-chat:local",
      sourceType: "acme-chat",
      declaresAnalytics: false,
    });
    // A conversational source transcribes inline and does not widen its
    // attachment allow-list; the two are mutually exclusive by construction.
    expect(host.transcribeAudio).toBe(transcribeAudio);
    expect(host.includeAudioTypes).toBe(false);
  });
});

describe("a provider context", () => {
  it("has no analytics access at all", () => {
    const host = buildProviderHost(inputs("/cfg"));
    expect((host as unknown as Record<string, unknown>).analytics).toBeUndefined();
  });

  it("shares the account directory with every source under it", () => {
    const provider = buildProviderHost(inputs("/cfg"));
    const source = buildSourceHost({
      ...inputs("/cfg"),
      sourceId: "acme-mail:person@example.com",
      sourceType: "acme-mail",
      declaresAnalytics: false,
    });
    expect(source.stateDir).toBe(provider.stateDir);
  });
});
