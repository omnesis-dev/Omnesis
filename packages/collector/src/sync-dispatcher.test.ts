// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { SyncDispatcher } from "./sync-dispatcher.js";
import type { SourceStatus } from "./source-lifecycle.js";
import type { SourceRegistry } from "./source-registry.js";
import type { ConnectionState } from "@omnesis/source-sdk";
import type { RegisteredProvider, RegisteredSource } from "./sync-engine-types.js";

const noopSync = async () => ({
  documents: [],
  deletedExternalIds: [],
  cursor: {},
  hasMore: false,
});

function makeSource(id: string, providerId: string): RegisteredSource {
  return { id, name: id, providerId, instance: { sync: noopSync } } as unknown as RegisteredSource;
}

function makeStatus(sourceId: string, providerId: string): SourceStatus {
  return { sourceId, providerId, sourceName: sourceId, state: "idle" };
}

/**
 * A registry stub holding exactly what the dispatcher reads: the statuses it
 * matches patterns against, the instances behind them, and the ledger of
 * sources this host is configured for but is not running.
 */
function makeRegistry(opts: {
  statuses?: SourceStatus[];
  sources?: RegisteredSource[];
  provider?: RegisteredProvider;
  unhosted?: Array<{ sourceId: string; providerId: string; error: string }>;
}): SourceRegistry {
  const statuses = opts.statuses ?? [];
  const sources = opts.sources ?? [];
  return {
    getStatuses: () => statuses,
    getStatus: (id: string) => statuses.find((s) => s.sourceId === id),
    getSourcesById: (id: string) => sources.filter((s) => String(s.id) === id),
    getProviderForSource: () => opts.provider,
    unhostedEntries: () => opts.unhosted ?? [],
    markNeedsAuth: vi.fn(),
  } as unknown as SourceRegistry;
}

describe("SyncDispatcher.triggerSync", () => {
  test("a source the host could not build reports why, not that nothing matched", () => {
    const dispatcher = new SyncDispatcher(
      makeRegistry({
        unhosted: [
          { sourceId: "vault-notes:acct", providerId: "vault:acct", error: "store is unreadable" },
        ],
      }),
      async () => undefined,
    );

    const result = dispatcher.triggerSync("vault-notes:acct");

    expect(result.triggered).toEqual([]);
    expect(result.unhosted).toEqual([
      { sourceId: "vault-notes:acct", error: "store is unreadable" },
    ]);
    expect(result.error).toBe("vault-notes:acct is not running here: store is unreadable");
  });

  test("a pattern matching nothing at all still says so", () => {
    const dispatcher = new SyncDispatcher(makeRegistry({}), async () => undefined);
    expect(dispatcher.triggerSync("nothing:here").error).toBe("No sources match: nothing:here");
  });

  test("a source that started and one the host cannot run are both reported", async () => {
    const source = makeSource("vault-notes:acct", "vault:acct");
    const provider = {
      id: "vault:acct",
      name: "vault",
      credentialState: () => Promise.resolve({ status: "connected" as const }),
      renewableCredential: true,
      sources: [source],
    } as unknown as RegisteredProvider;
    const runSync = vi.fn(async () => undefined);
    const dispatcher = new SyncDispatcher(
      makeRegistry({
        statuses: [makeStatus("vault-notes:acct", "vault:acct")],
        sources: [source],
        provider,
        unhosted: [
          { sourceId: "vault-tasks:acct", providerId: "vault:acct", error: "store is unreadable" },
        ],
      }),
      runSync,
    );

    const result = dispatcher.triggerSync("all");

    expect(result.triggered).toEqual(["vault-notes:acct"]);
    expect(result.error).toBe("vault-tasks:acct is not running here: store is unreadable");
  });

  test("a status with no instance behind it is never left claimed as syncing", () => {
    // The claim is optimistic — it is taken before the async auth check so two
    // rapid triggers cannot both fire. Taking it for a source that turns out to
    // have no instance would strand it: nothing but a real sync clears it, and
    // a sync never starts.
    const status = makeStatus("vault-notes:acct", "vault:acct");
    const dispatcher = new SyncDispatcher(
      makeRegistry({ statuses: [status], sources: [] }),
      async () => undefined,
    );

    const result = dispatcher.triggerSync("vault-notes:acct");

    expect(result.triggered).toEqual([]);
    expect(status.state).toBe("idle");
  });
});

describe("SyncDispatcher.triggerSync with restart", () => {
  function hostedSource(state: SourceStatus["state"], onResync?: () => void) {
    const source = makeSource("chat-synth:acct", "chat:acct");
    if (onResync) (source.instance as { onResync?: () => void }).onResync = onResync;
    const status = { ...makeStatus("chat-synth:acct", "chat:acct"), state };
    const provider = {
      id: "chat:acct",
      name: "chat",
      credentialState: () => Promise.resolve({ status: "connected" as const }),
      renewableCredential: true,
      sources: [source],
    } as unknown as RegisteredProvider;
    const requestRestart = vi.fn();
    const registry = makeRegistry({ statuses: [status], sources: [source], provider });
    (registry as unknown as { requestRestart: typeof requestRestart }).requestRestart =
      requestRestart;
    return { source, status, registry, requestRestart };
  }

  test("a source mid-sync is asked to restart rather than skipped", () => {
    const { registry, requestRestart } = hostedSource("syncing");
    const runSync = vi.fn(async () => undefined);
    const dispatcher = new SyncDispatcher(registry, runSync);

    const result = dispatcher.triggerSync("chat-synth:acct", { restart: true });

    expect(result.restarting).toEqual(["chat-synth:acct"]);
    expect(result.skipped).toEqual([]);
    expect(result.triggered).toEqual([]);
    expect(requestRestart).toHaveBeenCalledWith("chat-synth:acct");
    // The fresh run belongs to the aborted run's terminal transition, not here.
    expect(runSync).not.toHaveBeenCalled();
  });

  test("without restart a source mid-sync is still skipped", () => {
    const { registry, requestRestart } = hostedSource("syncing");
    const result = new SyncDispatcher(registry, async () => undefined).triggerSync(
      "chat-synth:acct",
    );
    expect(result.skipped).toEqual(["chat-synth:acct"]);
    expect(result.restarting).toEqual([]);
    expect(requestRestart).not.toHaveBeenCalled();
  });

  test("a restart on a provider that is no longer authenticated parks the source needs-auth", async () => {
    const { source, status, registry } = hostedSource("idle");
    registry.getProviderForSource = () =>
      ({
        id: "chat:acct",
        name: "chat",
        credentialState: () => Promise.resolve({ status: "revoked" as const }),
        renewableCredential: true,
        sources: [source],
      }) as unknown as RegisteredProvider;
    const runSync = vi.fn(async () => undefined);
    const dispatcher = new SyncDispatcher(registry, runSync);

    // A plain trigger rolls its claim back and leaves the next tick to say
    // why; the operator asked for the restart, so it is answered now.
    dispatcher.triggerSync("chat-synth:acct");
    await vi.waitFor(() => expect(status.state).toBe("idle"));
    expect(registry.markNeedsAuth).not.toHaveBeenCalled();

    expect(dispatcher.triggerSync("chat-synth:acct", { restart: true }).triggered).toEqual([
      "chat-synth:acct",
    ]);
    await vi.waitFor(() =>
      expect(registry.markNeedsAuth).toHaveBeenCalledWith(source, "chat:acct"),
    );
    expect(runSync).not.toHaveBeenCalled();
  });

  test("an idle source restarted resets its state through onResync before the sync", async () => {
    const calls: string[] = [];
    const { registry, requestRestart } = hostedSource("idle", () => calls.push("onResync"));
    const dispatcher = new SyncDispatcher(registry, async () => {
      calls.push("sync");
    });

    const result = dispatcher.triggerSync("chat-synth:acct", { restart: true });

    expect(result.triggered).toEqual(["chat-synth:acct"]);
    expect(result.restarting).toEqual([]);
    expect(requestRestart).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(calls).toEqual(["onResync", "sync"]));
  });
});

describe("the credential states a boolean could not carry", () => {
  function withCredential(credential: ConnectionState, renewableCredential = true) {
    const source = makeSource("chat-synth:acct", "chat:acct");
    const status = {
      ...makeStatus("chat-synth:acct", "chat:acct"),
      state: "idle" as SourceStatus["state"],
    };
    const provider = {
      id: "chat:acct",
      name: "chat",
      credentialState: () => Promise.resolve(credential),
      renewableCredential,
      sources: [source],
    } as unknown as RegisteredProvider;
    const registry = makeRegistry({ statuses: [status], sources: [source], provider });
    const runSync = vi.fn(async () => undefined);
    return { registry, runSync, source, status, dispatcher: new SyncDispatcher(registry, runSync) };
  }

  test("a credential that cannot be read does not park the source", async () => {
    // A locked keyring is a failure to answer the question, not an answer.
    // Parking on it turns a transient local condition into an outage and asks
    // the operator to re-authenticate a credential that is fine.
    const { dispatcher, registry, runSync } = withCredential({
      status: "unknown",
      because: "keyring is locked",
    });

    dispatcher.triggerSync("chat-synth:acct");

    await vi.waitFor(() => expect(runSync).toHaveBeenCalled());
    expect(registry.markNeedsAuth).not.toHaveBeenCalled();
  });

  test("a grant that is merely too narrow keeps syncing what it can reach", async () => {
    // Nothing has failed. Stopping would cost the data the grant does cover in
    // order to signal the data it does not.
    const { dispatcher, registry, runSync } = withCredential({
      status: "scope-insufficient",
      missing: ["calendar.read"],
    });

    dispatcher.triggerSync("chat-synth:acct");

    await vi.waitFor(() => expect(runSync).toHaveBeenCalled());
    expect(registry.markNeedsAuth).not.toHaveBeenCalled();
  });

  test("a grant with a deadline still ahead is a working grant", async () => {
    const { dispatcher, registry, runSync } = withCredential({
      status: "connected",
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    });

    dispatcher.triggerSync("chat-synth:acct");

    await vi.waitFor(() => expect(runSync).toHaveBeenCalled());
    expect(registry.markNeedsAuth).not.toHaveBeenCalled();
  });

  const BLOCKING: Array<[string, ConnectionState]> = [
    ["never-connected", { status: "never-connected" }],
    ["expired", { status: "expired" }],
    ["revoked", { status: "revoked" }],
    ["unlinked", { status: "unlinked" }],
  ];

  test.each(BLOCKING)("a %s credential stops the source syncing", async (_n, cred) => {
    const { dispatcher, runSync, status } = withCredential(cred);

    dispatcher.triggerSync("chat-synth:acct");

    // A plain trigger rolls its optimistic claim back and leaves the next tick
    // to say why, so that a routine trigger does not overwrite whatever the
    // source is already reporting.
    await vi.waitFor(() => expect(status.state).toBe("idle"));
    expect(runSync).not.toHaveBeenCalled();
  });

  test.each(BLOCKING)("a restart on a %s credential says why", async (_n, cred) => {
    // The operator asked, so they get the cause rather than a silent no-op.
    const { dispatcher, registry, runSync, source } = withCredential(cred);

    dispatcher.triggerSync("chat-synth:acct", { restart: true });

    await vi.waitFor(() =>
      expect(registry.markNeedsAuth).toHaveBeenCalledWith(source, "chat:acct"),
    );
    expect(runSync).not.toHaveBeenCalled();
  });
});

describe("a source with no credential to renew", () => {
  test("is never parked, whatever state it reports", async () => {
    // A local store has nothing an operator could re-authorize, so `needs-auth`
    // would offer a remedy that does not exist. Whatever is actually wrong
    // reaches them from the sync path, where it is described concretely.
    const source = makeSource("chat-synth:acct", "chat:acct");
    const status = { ...makeStatus("chat-synth:acct", "chat:acct"), state: "idle" as const };
    const provider = {
      id: "chat:acct",
      name: "chat",
      credentialState: () => Promise.resolve({ status: "revoked" as const }),
      renewableCredential: false,
      sources: [source],
    } as unknown as RegisteredProvider;
    const registry = makeRegistry({ statuses: [status], sources: [source], provider });
    const runSync = vi.fn(async () => undefined);
    const dispatcher = new SyncDispatcher(registry, runSync);

    dispatcher.triggerSync("chat-synth:acct", { restart: true });

    await vi.waitFor(() => expect(runSync).toHaveBeenCalled());
    expect(registry.markNeedsAuth).not.toHaveBeenCalled();
  });
});

describe("a source that is pushed to, not synced", () => {
  test("a manual trigger does not call its factory", async () => {
    // Its data arrives by being pushed to the gateway; the factory exists only
    // to satisfy the instance contract and returns an empty page. The
    // scheduler already leaves these alone and the portal hides the action,
    // but a command from the CLI reaches this path.
    const source = { ...makeSource("web:local", "web:local"), pushBased: true };
    const status = { ...makeStatus("web:local", "web:local"), state: "idle" as const };
    const provider = {
      id: "web:local",
      name: "web",
      credentialState: () => Promise.resolve({ status: "connected" as const }),
      renewableCredential: false,
      sources: [source],
    } as unknown as RegisteredProvider;
    const registry = makeRegistry({ statuses: [status], sources: [source], provider });
    const runSync = vi.fn(async () => undefined);
    const dispatcher = new SyncDispatcher(registry, runSync);

    const result = dispatcher.triggerSync("web:local");

    expect(result.skipped).toEqual(["web:local"]);
    expect(result.triggered).toEqual([]);
    await new Promise((r) => setImmediate(r));
    expect(runSync).not.toHaveBeenCalled();
  });

  test("an ordinary source is still triggered", () => {
    // The guard must read the flag, not the shape of the id.
    const source = makeSource("chat-synth:acct", "chat:acct");
    const status = { ...makeStatus("chat-synth:acct", "chat:acct"), state: "idle" as const };
    const provider = {
      id: "chat:acct",
      name: "chat",
      credentialState: () => Promise.resolve({ status: "connected" as const }),
      renewableCredential: true,
      sources: [source],
    } as unknown as RegisteredProvider;
    const registry = makeRegistry({ statuses: [status], sources: [source], provider });
    const dispatcher = new SyncDispatcher(
      registry,
      vi.fn(async () => undefined),
    );

    expect(dispatcher.triggerSync("chat-synth:acct").triggered).toEqual(["chat-synth:acct"]);
  });
});
