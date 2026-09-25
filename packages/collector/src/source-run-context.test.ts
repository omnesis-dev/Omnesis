// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the host tells a source about the run it is in.
 *
 * Every field was already computed before the sync call and then dropped. The
 * tests here drive the real trigger paths rather than handing a source a
 * constructed run: a test that builds the state itself is testing an
 * assumption about how that state arises, and on this branch that assumption
 * has been the thing that was wrong.
 */

import { describe, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { SourceRegistry } from "./source-registry.js";
import { SyncScheduler } from "./sync-scheduler.js";
import { FileWatcherManager } from "./file-watcher-manager.js";
import { SyncDispatcher } from "./sync-dispatcher.js";
import { SourceSyncRunner } from "./source-sync-runner.js";
import type { GatewayClient, SyncOptions, SyncRun } from "@omnesis/source-sdk";
import type { RegisteredSource, RegisteredProvider } from "./sync-engine-types.js";

const SOURCE_ID = "obsidian-notes:Vault";

/** A source that records the run it was handed on each page. */
function recordingSource(runs: (SyncRun | undefined)[], pages = 1): RegisteredSource {
  let page = 0;
  return {
    id: SourceId(SOURCE_ID),
    name: SOURCE_ID,
    providerId: ProviderId("obsidian:Vault"),
    family: { name: "Obsidian" },
    instance: {
      sync: async (_cursor: unknown, opts?: SyncOptions) => {
        runs.push(opts?.run);
        page += 1;
        return { documents: [], deletedExternalIds: [], cursor: { page }, hasMore: page < pages };
      },
    },
  } as unknown as RegisteredSource;
}

function provider(source: RegisteredSource): RegisteredProvider {
  return {
    id: source.providerId,
    name: "Obsidian",
    sources: [source],
    credentialState: async () => ({ status: "connected" as const }),
  } as unknown as RegisteredProvider;
}

function harness(source: RegisteredSource) {
  const registry = new SourceRegistry(new SyncScheduler(), new FileWatcherManager(() => {}));
  registry.registerProvider(provider(source));
  const seen: string[] = [];
  const dispatcher = new SyncDispatcher(registry, async (s, reason) => {
    seen.push(reason);
    void s;
    return undefined;
  });
  return { registry, dispatcher, seen };
}

describe("the reason a run started reaches the host", () => {
  test("a scheduled tick and a boot catch-up are told apart", async () => {
    const source = recordingSource([]);
    const { dispatcher, seen } = harness(source);

    await dispatcher.tickSource(source, provider(source), "scheduled");
    await dispatcher.tickSource(source, provider(source), "boot");

    expect(seen).toEqual(["scheduled", "boot"]);
  });

  /** Trigger once on a fresh harness and return the reason the host received. */
  async function reasonFor(opts?: {
    restart?: boolean;
    reason?: NonNullable<Parameters<SyncDispatcher["triggerSync"]>[1]>["reason"];
  }) {
    const source = recordingSource([]);
    const { dispatcher, seen } = harness(source);
    dispatcher.triggerSync(SOURCE_ID, opts ?? {});
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    return seen[0];
  }

  test("a plain trigger reads as a person asking, and a restart as a resync", async () => {
    // Both are people; only one reset the cursor first, and a source may want
    // to behave differently about that.
    expect(await reasonFor()).toBe("manual");
    expect(await reasonFor({ restart: true })).toBe("resync");
  });

  test("an automatic trigger names itself rather than passing as a person's", async () => {
    expect(await reasonFor({ reason: "push" })).toBe("push");
    expect(await reasonFor({ reason: "file-change" })).toBe("file-change");
  });
});

describe("what a source is told about the run it is in", () => {
  /** Drive a real run through the runner and collect what each page received. */
  async function runPages(pages: number, reason?: Parameters<SourceSyncRunner["runOne"]>[1]) {
    const runs: (SyncRun | undefined)[] = [];
    const source = recordingSource(runs, pages);
    const registry = new SourceRegistry(new SyncScheduler(), new FileWatcherManager(() => {}));
    registry.registerProvider(provider(source));
    const gateway = {
      getWipeEpoch: async () => 0,
      getSyncState: async () => null,
      upsertWithCursor: async () => ({ inserted: 0, updated: 0, deleted: 0 }),
      saveSyncState: async () => undefined,
    } as unknown as GatewayClient;
    await new SourceSyncRunner(gateway, registry, 60_000).runOne(source, reason);
    // A run that ended in error would leave the page counts meaningless.
    expect(registry.getStatus(source.id)?.state).not.toBe("error");
    return runs;
  }

  test("the run carries the id the host fences its writes with, and it is stable across pages", async () => {
    const runs = await runPages(3);
    expect(runs).toHaveLength(3);
    const ids = new Set(runs.map((r) => r?.id));
    // One run, one id — a source can put it in its own logs and an operator
    // can tie what it said to the attempt they were looking at.
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
  });

  test("the page number advances, so a source can tell its first page from its tenth", async () => {
    const runs = await runPages(3);
    expect(runs.map((r) => r?.page)).toEqual([0, 1, 2]);
  });

  test("the deadline is the one the host will actually enforce", async () => {
    const before = Date.now();
    const runs = await runPages(1);
    const deadline = runs[0]?.deadline ?? 0;
    // Two sources race private timers against this because they could not see
    // it. It is the wall clock the host stops waiting at, not a guess.
    expect(deadline).toBeGreaterThanOrEqual(before + 60_000 - 1_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  test("the reason the operator's action produced reaches the source unchanged", async () => {
    expect((await runPages(1, "resync"))[0]?.reason).toBe("resync");
    expect((await runPages(1, "push"))[0]?.reason).toBe("push");
  });
});

describe("what a run cost that it survived", () => {
  /** A source that reports an issue on its first page and nothing on its second. */
  function skippingSource(): RegisteredSource {
    let page = 0;
    return {
      id: SourceId(SOURCE_ID),
      name: SOURCE_ID,
      providerId: ProviderId("obsidian:Vault"),
      family: { name: "Obsidian" },
      instance: {
        sync: async () => {
          page += 1;
          return {
            documents: [],
            deletedExternalIds: [],
            cursor: { page },
            hasMore: page < 2,
            ...(page === 1
              ? {
                  issues: [
                    {
                      scope: "partition" as const,
                      kind: "permission" as const,
                      count: 3,
                      subject: "Archive",
                      message: "3 notes under Archive could not be read",
                    },
                  ],
                }
              : {}),
          };
        },
      },
    } as unknown as RegisteredSource;
  }

  async function runAndReadStatus(source: RegisteredSource) {
    const registry = new SourceRegistry(new SyncScheduler(), new FileWatcherManager(() => {}));
    registry.registerProvider(provider(source));
    const gateway = {
      getWipeEpoch: async () => 0,
      getSyncState: async () => null,
      upsertWithCursor: async () => ({ inserted: 0, updated: 0, deleted: 0 }),
      saveSyncState: async () => undefined,
    } as unknown as GatewayClient;
    await new SourceSyncRunner(gateway, registry, 60_000).runOne(source);
    return registry.getStatus(SOURCE_ID);
  }

  test("an issue survives the run that reported it, and does not fail it", async () => {
    const status = await runAndReadStatus(skippingSource());
    // Still a success. A source that skipped a folder has synced.
    expect(status?.state).toBe("idle");
    expect(status?.issues).toHaveLength(1);
    expect(status?.issues?.[0]).toMatchObject({ count: 3, subject: "Archive" });
  });

  test("a page that reports nothing does not erase what an earlier page reported", async () => {
    // The reporting page is the first of two, so the second page's silence is
    // what would drop it — the shape that cost the coverage claim its life.
    const status = await runAndReadStatus(skippingSource());
    expect(status?.issues).toHaveLength(1);
  });

  test("a clean run leaves nothing behind from the run before it", async () => {
    const source = skippingSource();
    await runAndReadStatus(source);
    // A second, clean run over the same registry: the folder opens now, so the
    // operator should not still be told it did not.
    const status = await runAndReadStatus(recordingSource([], 1));
    expect(status?.issues).toBeUndefined();
  });
});
