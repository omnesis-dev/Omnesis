// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for source-ws-handlers — the WS command handlers that the
 * gateway dispatches to the collector for source.descriptors / source.discover
 * / source.validate-param / source.add / sources.snapshot.request.
 */

import { spawn } from "node:child_process";
import { describe, test, expect } from "vitest";
import { makeCommand } from "@omnesis/core";
import { AccountId, ProviderType, SourceType } from "@omnesis/types";
import { createSourceWsHandlers, endedFlowOutcome, terminateChild } from "./source-ws-handlers.js";
import type { SourceConfig } from "@omnesis/core";
import type {
  GatewayClient,
  SourceDescriptor,
  ImportCallbacks,
  ImportSummary,
} from "@omnesis/source-sdk";

function fakeDescriptor(over: Partial<SourceDescriptor> = {}): SourceDescriptor {
  return {
    id: SourceType("test-source"),
    name: "Test Source",
    description: "test",
    provider: { id: ProviderType("test-provider"), name: "Test" },
    authType: "local",
    unitName: "items",
    discover: async () => [{ id: AccountId("alice") }, { id: AccountId("bob") }],
    cleanupCredentials: async () => {},
    params: [
      {
        name: "path",
        label: "Path",
        type: "path",
        required: true,
        validate: (v) => (v.startsWith("/") ? null : "must be absolute"),
      },
    ],
    ...over,
  };
}

function fakeManager(
  over: {
    descriptors?: SourceDescriptor[];
    configured?: Record<string, SourceConfig>;
    addSourcesResult?: { sourceIds: string[] };
    reauthProviderResult?: { sourceIds: string[] };
    reauthProviderImpl?: (
      providerType: string,
      accountId: string,
    ) => Promise<{ sourceIds: string[] }>;
    importHistoryImpl?: (
      sourceId: string,
      values: Record<string, string>,
      callbacks: ImportCallbacks,
    ) => Promise<ImportSummary>;
  } = {},
): {
  getDescriptors: () => SourceDescriptor[];
  getConfiguredSources: () => Record<string, SourceConfig>;
  getConfig: () => object;
  getConfigDir: () => string;
  resolveAccountId: (descriptorId: string, params: Record<string, string>) => Promise<string>;
  addSources: (req: unknown) => Promise<{ sourceIds: string[] }>;
  reauthProvider: (providerType: string, accountId: string) => Promise<{ sourceIds: string[] }>;
  importHistory: (
    sourceId: string,
    values: Record<string, string>,
    callbacks: ImportCallbacks,
  ) => Promise<ImportSummary>;
} {
  const descriptors = over.descriptors ?? [fakeDescriptor()];
  const configured = over.configured ?? {};
  return {
    getDescriptors: () => descriptors,
    getConfiguredSources: () => configured,
    getConfig: () => ({}),
    getConfigDir: () => "/tmp/omnesis-test-config",
    resolveAccountId: async (_descriptorId, params) => `resolved-${params.path}`,
    addSources: async () => over.addSourcesResult ?? { sourceIds: ["test-source:alice"] },
    reauthProvider:
      over.reauthProviderImpl ??
      (async () => over.reauthProviderResult ?? { sourceIds: ["test-source:alice"] }),
    importHistory:
      over.importHistoryImpl ??
      (async (_sid, _vals, cb) => {
        cb.onProgress?.({ phase: "merge", processed: 1, total: 1 });
        return { imported: 1, merged: 0, skipped: 0 };
      }),
  };
}

const fakeGateway = {} as GatewayClient;

describe("source-ws-handlers", () => {
  test("source.descriptors returns serialized descriptor list", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager() as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = (await handlers.handle(makeCommand("source.descriptors", {}))) as {
      descriptors: Array<{ id: string; hasDiscover: boolean }>;
    };
    expect(result.descriptors).toHaveLength(1);
    expect(result.descriptors[0].id).toBe("test-source");
    expect(result.descriptors[0].hasDiscover).toBe(true);
  });

  test("source.descriptors keeps push-based sources in the feed", async () => {
    // Push-based sources (browser extension) MUST stay in this feed — it
    // populates the source-icon/metadata catalog the portal + iOS read, so
    // dropping them would strip their icon everywhere. Hiding them from the
    // "+ Add source" picker is the picker's job (it filters on `pushBased`).
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({
        descriptors: [
          fakeDescriptor({ id: SourceType("pull-source") }),
          fakeDescriptor({ id: SourceType("push-source"), pushBased: true }),
        ],
      }) as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = (await handlers.handle(makeCommand("source.descriptors", {}))) as {
      descriptors: Array<{ id: string }>;
    };
    const ids = result.descriptors.map((d) => d.id);
    expect(ids).toContain("pull-source");
    expect(ids).toContain("push-source"); // kept for its icon; the picker hides it
  });

  test("source.descriptors excludes gatewayHosted sources — the gateway owns them", async () => {
    // A gateway-hosted source (the unified Web Pages dataset) is advertised by
    // the gateway itself, not the collector — even though the collector still
    // carries the provider package in its registry. The collector must drop it
    // here so the gateway's descriptor doesn't depend on a collector being up.
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({
        descriptors: [
          fakeDescriptor({ id: SourceType("pull-source") }),
          fakeDescriptor({ id: SourceType("web"), gatewayHosted: true, pushBased: true }),
        ],
      }) as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = (await handlers.handle(makeCommand("source.descriptors", {}))) as {
      descriptors: Array<{ id: string }>;
    };
    const ids = result.descriptors.map((d) => d.id);
    expect(ids).toContain("pull-source");
    expect(ids).not.toContain("web"); // gateway-hosted — advertised by the gateway only
  });

  // The portal "+ Add source" picker reads d.icon directly off the
  // serialized descriptor (see packages/gateway/portal/js/views/add-source.js
  // descriptorIcon()). Without this propagation every tile falls back to
  // the generic 📄 emoji on a fresh bootstrap because sync_state is empty.
  test("source.descriptors propagates the definition-level icon (url variant)", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({
        descriptors: [
          fakeDescriptor({
            icon: {
              sfSymbol: "envelope.fill",
              color: "#EA4335",
              url: "https://example.com/icon.svg",
            },
          }),
        ],
      }) as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = (await handlers.handle(makeCommand("source.descriptors", {}))) as {
      descriptors: Array<{
        icon?: { sfSymbol?: string; color?: string; url?: string; imageDataUri?: string };
      }>;
    };
    expect(result.descriptors[0].icon).toEqual({
      sfSymbol: "envelope.fill",
      color: "#EA4335",
      url: "https://example.com/icon.svg",
    });
  });

  test("source.descriptors propagates a bundled imageDataUri icon", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({
        descriptors: [
          fakeDescriptor({
            icon: {
              sfSymbol: "note.text",
              color: "#FFCC00",
              imageDataUri: "data:image/svg+xml;base64,PHN2Zy8+",
            },
          }),
        ],
      }) as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = (await handlers.handle(makeCommand("source.descriptors", {}))) as {
      descriptors: Array<{
        icon?: { sfSymbol?: string; color?: string; url?: string; imageDataUri?: string };
      }>;
    };
    expect(result.descriptors[0].icon?.imageDataUri).toBe("data:image/svg+xml;base64,PHN2Zy8+");
  });

  test("source.descriptors propagates attribution", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({
        descriptors: [
          fakeDescriptor({
            attribution: { itemFooter: "Powered by Strava" },
          }),
        ],
      }) as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = (await handlers.handle(makeCommand("source.descriptors", {}))) as {
      descriptors: Array<{ attribution?: { itemFooter?: string } }>;
    };
    expect(result.descriptors[0].attribution?.itemFooter).toBe("Powered by Strava");
  });

  test("source.validate-param returns error for invalid value", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager() as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = (await handlers.handle(
      makeCommand("source.validate-param", {
        descriptorId: "test-source",
        paramName: "path",
        value: "not-absolute",
      }),
    )) as { valid: boolean; error?: string };
    expect(result.valid).toBe(false);
    expect(result.error).toBe("must be absolute");
  });

  test("source.validate-param accepts valid value", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager() as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = (await handlers.handle(
      makeCommand("source.validate-param", {
        descriptorId: "test-source",
        paramName: "path",
        value: "/Users/a/b",
      }),
    )) as { valid: boolean };
    expect(result.valid).toBe(true);
  });

  test("source.discover invokes the descriptor discover hook with configDir", async () => {
    let seenConfigDir: string | undefined;
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({
        descriptors: [
          fakeDescriptor({
            discover: async (ctx) => {
              seenConfigDir = ctx?.configDir;
              return [{ id: AccountId("alice") }, { id: AccountId("bob") }];
            },
          }),
        ],
      }) as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = (await handlers.handle(
      makeCommand("source.discover", { descriptorId: "test-source" }),
    )) as { accounts: string[] };
    expect(result.accounts).toEqual(["alice", "bob"]);
    expect(seenConfigDir).toBe("/tmp/omnesis-test-config");
  });

  test("source.resolve-account delegates local identity to the manager", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager() as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = await handlers.handle(
      makeCommand("source.resolve-account", {
        descriptorId: "test-source",
        params: { path: "vault" },
      }),
    );
    expect(result).toEqual({ accountId: "resolved-vault" });
  });

  test("source.discover errors when descriptor lacks discover", async () => {
    const noDiscover = fakeDescriptor({ discover: undefined });
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({ descriptors: [noDiscover] }) as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const promise = handlers.handle(
      makeCommand("source.discover", { descriptorId: "test-source" }),
    );
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise as Promise<unknown>).rejects.toThrow(/does not support discovery/);
  });

  test("sources.snapshot.request returns the configured sources", async () => {
    const configured: Record<string, SourceConfig> = {
      "test-source:alice": { enabled: true, syncInterval: "5m" },
    };
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({ configured }) as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = (await handlers.handle(makeCommand("sources.snapshot.request", {}))) as {
      configured: Record<string, unknown>;
    };
    expect(result.configured["test-source:alice"]).toBeDefined();
  });

  test("source.add delegates to sourceManager.addSources", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({
        addSourcesResult: { sourceIds: ["test-source:alice", "test-source:bob"] },
      }) as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = (await handlers.handle(
      makeCommand("source.add", {
        descriptorId: "test-source",
        accountIds: ["alice", "bob"],
      }),
    )) as { sourceIds: string[] };
    expect(result.sourceIds).toEqual(["test-source:alice", "test-source:bob"]);
  });

  test("source.add fires onSourcesChanged after registration", async () => {
    let changed = 0;
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({
        addSourcesResult: { sourceIds: ["test-source:alice"] },
      }) as never,
      gateway: fakeGateway,
      emitEvent: () => {},
      onSourcesChanged: () => {
        changed++;
      },
    });
    await handlers.handle(
      makeCommand("source.add", { descriptorId: "test-source", accountIds: ["alice"] }),
    );
    expect(changed).toBe(1);
  });

  test("source.reauth-finalize delegates to sourceManager.reauthProvider", async () => {
    let calledWith: { providerType?: string; accountId?: string } | null = null;
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({
        reauthProviderImpl: async (providerType, accountId) => {
          calledWith = { providerType, accountId };
          return { sourceIds: ["gmail:user@gmail.com", "google-calendar:user@gmail.com"] };
        },
      }) as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = (await handlers.handle(
      makeCommand("source.reauth-finalize", {
        providerType: "google",
        accountId: "user@gmail.com",
      }),
    )) as { sourceIds: string[] };
    expect(calledWith).toEqual({
      providerType: "google",
      accountId: "user@gmail.com",
    });
    expect(result.sourceIds).toEqual(["gmail:user@gmail.com", "google-calendar:user@gmail.com"]);
  });

  test("source.reauth-finalize rejects payload without providerType", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager() as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const promise = handlers.handle(
      makeCommand("source.reauth-finalize", { accountId: "user@gmail.com" }),
    );
    expect(promise).toBeInstanceOf(Promise);
    // The typed dispatcher rejects via the registry's zod schema. Error
    // shape: `invalid <type> payload: <path>: <zod message>`.
    await expect(promise as Promise<unknown>).rejects.toThrow(/providerType/);
  });

  test("source.reauth-finalize rejects payload without accountId", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager() as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const promise = handlers.handle(
      makeCommand("source.reauth-finalize", { providerType: "google" }),
    );
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise as Promise<unknown>).rejects.toThrow(/accountId/);
  });

  test("unknown command returns undefined (caller falls through)", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager() as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    expect(handlers.handle(makeCommand("source.sync", { sourceId: "x" }))).toBeUndefined();
  });

  test("auth.cancel emits auth.complete with cancelled error", async () => {
    let captured: { type?: string; payload?: unknown } | null = null;
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager() as never,
      gateway: fakeGateway,
      emitEvent: (type, payload) => {
        captured = { type, payload };
      },
    });
    // Cancelling a flow we never started is a no-op (no active subprocess) but
    // should still resolve cleanly.
    const result = (await handlers.handle(makeCommand("auth.cancel", { flowId: "nope" }))) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
    // No subprocess was active so no event is emitted.
    expect(captured).toBeNull();
  });

  // Auth subprocess shutdown coverage. shutdown() with
  // no active flows must resolve cleanly and be idempotent so the
  // collector's SIGINT/SIGTERM handler can call it unconditionally.
  test("shutdown resolves cleanly with no active flows", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager() as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    await expect(handlers.shutdown()).resolves.toBeUndefined();
    // Idempotent — second call is also a no-op.
    await expect(handlers.shutdown()).resolves.toBeUndefined();
  });
});

// terminateChild is the SIGTERM-then-SIGKILL helper that
// shutdown() and handleAuthCancel both rely on. Spinning up a real
// long-running child is the only honest way to verify the signal
// escalation actually fires; the kill() calls are otherwise just
// no-op invocations on a settled handle.
describe("terminateChild", () => {
  test("SIGTERMs a long-running child and resolves on exit", async () => {
    const child = spawn("node", ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    // Give the child a moment to be fully spawned before we signal it
    // (otherwise kill() can race against the spawn syscall on slow CI).
    await new Promise((r) => setTimeout(r, 50));
    expect(child.exitCode).toBeNull();
    await terminateChild(child);
    expect(child.exitCode === 0 || child.signalCode === "SIGTERM").toBe(true);
  });

  test("resolves immediately on an already-exited child", async () => {
    const child = spawn("node", ["-e", "process.exit(0)"], { stdio: "ignore" });
    // Wait for natural exit.
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.exitCode).toBe(0);
    // Should resolve without sending any new signal — the early return
    // skips the Promise + signal path entirely.
    const start = Date.now();
    await terminateChild(child);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe("source-ws-handlers (descriptors / credentials)", () => {
  test("source.descriptors includes hostname for same-host detection", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager() as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = (await handlers.handle(makeCommand("source.descriptors", {}))) as {
      descriptors: unknown[];
      hostname: string;
    };
    expect(typeof result.hostname).toBe("string");
    expect(result.hostname.length).toBeGreaterThan(0);
  });

  test("credentials.status returns one entry per provider with a credentials spec", async () => {
    const credSpec = {
      fileKey: "test-cred",
      required: true,
      fields: [{ name: "client_id", label: "Client ID" }],
      wizard: { intro: "x", why: "y", estMinutes: 1, steps: [] },
    };
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({
        descriptors: [
          fakeDescriptor({ id: SourceType("a"), credentials: credSpec }),
          fakeDescriptor({ id: SourceType("b"), credentials: credSpec }),
          fakeDescriptor({ id: SourceType("c") }),
        ],
      }) as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    const result = (await handlers.handle(makeCommand("credentials.status", {}))) as {
      hostname: string;
      entries: Array<{ fileKey: string; configured: boolean; spec: { required: boolean } }>;
    };
    // Both `a` and `b` share the same fileKey — one entry, not two.
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].fileKey).toBe("test-cred");
    expect(result.entries[0].spec.required).toBe(true);
    expect(typeof result.entries[0].configured).toBe("boolean");
  });

  test("credentials.set rejects unknown fileKey", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager() as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    await expect(
      handlers.handle(
        makeCommand("credentials.set", {
          fileKey: "bogus",
          fields: { client_id: "x" },
        }),
      ),
    ).rejects.toThrow(/Unknown credentials fileKey/);
  });

  test("credentials.set rejects empty field values", async () => {
    const credSpec = {
      fileKey: "test-cred",
      required: true,
      fields: [{ name: "client_id", label: "Client ID" }],
      wizard: { intro: "x", why: "y", estMinutes: 1, steps: [] },
    };
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({
        descriptors: [fakeDescriptor({ credentials: credSpec })],
      }) as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    await expect(
      handlers.handle(
        makeCommand("credentials.set", {
          fileKey: "test-cred",
          fields: { client_id: "" },
        }),
      ),
    ).rejects.toThrow(/required/);
  });

  test("credentials.set enforces field pattern", async () => {
    const credSpec = {
      fileKey: "test-cred",
      required: true,
      fields: [
        {
          name: "client_id",
          label: "Client ID",
          pattern: "^\\d+$",
          patternHint: "must be digits",
        },
      ],
      wizard: { intro: "x", why: "y", estMinutes: 1, steps: [] },
    };
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({
        descriptors: [fakeDescriptor({ credentials: credSpec })],
      }) as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    await expect(
      handlers.handle(
        makeCommand("credentials.set", {
          fileKey: "test-cred",
          fields: { client_id: "abc" },
        }),
      ),
    ).rejects.toThrow(/digits/);
  });

  test("credentials.clear rejects unknown fileKey", async () => {
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager() as never,
      gateway: fakeGateway,
      emitEvent: () => {},
    });
    await expect(
      handlers.handle(makeCommand("credentials.clear", { fileKey: "bogus" })),
    ).rejects.toThrow(/Unknown credentials fileKey/);
  });

  // ── History import ──

  test("import.begin returns started + emits progress then a complete with the tally", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager() as never,
      gateway: fakeGateway,
      emitEvent: (type, payload) =>
        events.push({ type, payload: payload as Record<string, unknown> }),
    });
    const res = await handlers.handle(
      makeCommand("import.begin", { flowId: "f1", sourceId: "test-source:alice", values: {} }),
    );
    expect(res).toEqual({ started: true });
    await new Promise((r) => setTimeout(r, 10)); // let the async import settle
    expect(events.map((e) => e.type)).toEqual(["import.progress", "import.complete"]);
    expect(events[1].payload).toMatchObject({ flowId: "f1", ok: true, imported: 1 });
  });

  test("import.cancel aborts the run and yields exactly one cancelled complete", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let aborted = false;
    const handlers = createSourceWsHandlers({
      sourceManager: fakeManager({
        // A run that only settles when its signal aborts.
        importHistoryImpl: (_sid, _vals, cb) =>
          new Promise((_resolve, reject) => {
            cb.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("cancelled"));
            });
          }),
      }) as never,
      gateway: fakeGateway,
      emitEvent: (type, payload) =>
        events.push({ type, payload: payload as Record<string, unknown> }),
    });
    await handlers.handle(
      makeCommand("import.begin", { flowId: "f2", sourceId: "test-source:alice", values: {} }),
    );
    await handlers.handle(makeCommand("import.cancel", { flowId: "f2" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(true);
    const completes = events.filter((e) => e.type === "import.complete");
    expect(completes).toHaveLength(1); // single authority — no double-complete (L5)
    expect(completes[0].payload).toMatchObject({ flowId: "f2", ok: false, error: "cancelled" });
  });
});

describe("what the operator is told when a flow ends without connecting", () => {
  test("a refusal at the platform is reported as a refusal, with the sentence it came with", () => {
    // The one moment a platform says the operator declined is an `error=` on
    // the redirect. Reporting it as a cancellation loses both the code a client
    // switches on and the mapped sentence, which on that path is the only thing
    // telling the operator what they did.
    expect(endedFlowOutcome("denied", "Access was declined at the provider.")).toEqual({
      ok: false,
      error: "Access was declined at the provider.",
      code: "denied",
    });
  });

  test("a flow that was stopped is a cancellation, which is a different event", () => {
    expect(endedFlowOutcome("cancelled", undefined)).toEqual({
      ok: false,
      error: "cancelled",
      code: "user-cancelled",
    });
    expect(endedFlowOutcome(undefined, undefined).code).toBe("user-cancelled");
  });

  test("a refusal with nothing said still reads as a refusal", () => {
    expect(endedFlowOutcome("denied", undefined).code).toBe("denied");
  });
});
