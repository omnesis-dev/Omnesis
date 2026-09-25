// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * auth.begin → runFlowSubprocess lifecycle coverage.
 *
 * The rest of source-ws-handlers is unit-tested in
 * `source-ws-handlers.test.ts`, but the NDJSON-streaming auth engine is
 * not. These pin the protocol invariants the portal relies on:
 *
 *   - exactly one terminal `auth.complete` event per flow, with
 *     post-terminal and malformed lines dropped;
 *   - `auth.update` forwarding of intermediate `url`/`qr` events;
 *   - `code: "unknown"` when the subprocess closes stdout without ever
 *     emitting a terminal event (the exact failure the emit-drain fix
 *     guards against).
 *
 * `node:child_process.spawn` is mocked so a hand-driven fake child (its
 * stdout a real PassThrough we push NDJSON into) replaces the real
 * `npx tsx auth-subprocess.ts` invocation — fully deterministic, no tsx
 * cold-start, no wall-clock sleeps.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, test, expect, vi, beforeEach } from "vitest";

/** A spawn() stand-in: stdin/stdout/stderr PassThroughs + kill/exit plumbing. */
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  /** Everything the handler wrote to the child's stdin, accumulated. */
  stdinData = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => {
      this.stdinData += chunk.toString();
    });
  }

  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true;
    return true;
  }

  /** Parsed NDJSON lines written to stdin so far. */
  stdinLines(): unknown[] {
    return this.stdinData
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as unknown);
  }

  /** Write one NDJSON line to stdout (the parser splits on `\n`). */
  emitLine(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }

  /** Write a raw (possibly malformed) line. */
  emitRaw(line: string): void {
    this.stdout.write(line + "\n");
  }

  /** Close stdout → drives the consumer's `for await` loop to completion. */
  endStdout(): void {
    this.stdout.end();
    this.stderr.end();
  }
}

// A plain hoisted holder shared between the (hoisted) vi.mock factory and
// the test body. It carries no module-import dependencies, so it is safe
// to construct before the top-level imports evaluate. `make` is wired up
// after imports below; the factory only reads it lazily, when spawn() is
// actually called inside a test.
const childHolder = vi.hoisted(() => ({
  children: [] as FakeChild[],
  make: null as null | (() => FakeChild),
  spawnCalls: [] as Array<{
    command: string;
    args: string[];
    options: { env?: Record<string, string> };
  }>,
}));

// Override only spawn(); preserve the rest of node:child_process so that
// other consumers (e.g. @omnesis/core's network-discovery, which wraps
// execFile in promisify at import time) keep working.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[], options: { env?: Record<string, string> }) => {
      const child = childHolder.make!();
      childHolder.children.push(child);
      childHolder.spawnCalls.push({ command, args, options });
      return child;
    }),
  };
});

import { KEYRING_ENV_KEYS, makeCommand } from "@omnesis/core";
import { type GatewayClient, type SourceDescriptor } from "@omnesis/source-sdk";
import { AccountId, ProviderType, SourceType } from "@omnesis/types";
import { createSourceWsHandlers } from "./source-ws-handlers.js";

childHolder.make = () => new FakeChild();
const spawnedChildren = childHolder.children;

function authDescriptor(over: Partial<SourceDescriptor> = {}): SourceDescriptor {
  return {
    id: SourceType("test-auth-source"),
    name: "Test Auth Source",
    description: "test",
    provider: { id: ProviderType("test-provider"), name: "Test" },
    authType: "oauth",
    unitName: "items",
    // Presence of authFlow is the only thing handleAuthBegin checks; the
    // body never runs because spawn() is mocked.
    authFlow: () => Promise.resolve(AccountId("unused")),
    ...over,
  };
}

function fakeManager(descriptors: SourceDescriptor[]): {
  getDescriptors: () => SourceDescriptor[];
  getConfigDir: () => string;
} {
  return { getDescriptors: () => descriptors, getConfigDir: () => "/tmp/omnesis-auth-config" };
}

/**
 * Poll a predicate by yielding to the event loop (setImmediate), no
 * wall-clock sleep. Stream `end` events that drive the terminal emit
 * land within a few ticks of `endStdout()`.
 */
async function waitFor(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  if (!predicate()) throw new Error("waitFor: predicate never became true");
}

type Emitted = { type: string; payload: Record<string, unknown> };

function setup(descriptors: SourceDescriptor[]): {
  handlers: ReturnType<typeof createSourceWsHandlers>;
  emitted: Emitted[];
} {
  const emitted: Emitted[] = [];
  const handlers = createSourceWsHandlers({
    sourceManager: fakeManager(descriptors) as never,
    gateway: {} as GatewayClient,
    emitEvent: (type, payload) => {
      emitted.push({ type, payload: payload as Record<string, unknown> });
    },
  });
  return { handlers, emitted };
}

beforeEach(() => {
  spawnedChildren.length = 0;
  childHolder.spawnCalls.length = 0;
});

describe("auth.begin → runFlowSubprocess", () => {
  test("forwards url as auth.update, then emits exactly one terminal auth.complete on success", async () => {
    const { handlers, emitted } = setup([authDescriptor()]);

    const started = (await handlers.handle(
      makeCommand("auth.begin", { flowId: "flow-1", sourceType: "test-auth-source" }),
    )) as { started: boolean };
    expect(started.started).toBe(true);
    expect(spawnedChildren).toHaveLength(1);

    const child = spawnedChildren[0];
    child.emitLine({ type: "url", url: "https://auth.example.com/consent?flow=flow-1" });
    child.emitLine({ type: "complete", accountIds: ["maya@example.com"] });
    // Post-terminal noise the protocol must drop:
    child.emitLine({ type: "url", url: "https://auth.example.com/late" });
    child.emitRaw("not-json-garbage}{");
    child.endStdout();

    await waitFor(() => emitted.some((e) => e.type === "auth.complete"));

    const updates = emitted.filter((e) => e.type === "auth.update");
    const completes = emitted.filter((e) => e.type === "auth.complete");

    // Exactly one terminal event — the trailing url after `complete`
    // must NOT have produced a second auth.update.
    expect(completes).toHaveLength(1);
    // `accountId` mirrors the first id (single-account back-compat); the full
    // set rides on `accountIds`.
    expect(completes[0].payload).toEqual({
      flowId: "flow-1",
      ok: true,
      accountId: "maya@example.com",
      accountIds: ["maya@example.com"],
    });
    // Only the pre-terminal url was forwarded.
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({
      flowId: "flow-1",
      type: "url",
      url: "https://auth.example.com/consent?flow=flow-1",
    });
  });

  test("a multi-account complete forwards all ids on accountIds (one-session → many-institutions)", async () => {
    const { handlers, emitted } = setup([authDescriptor()]);

    await handlers.handle(
      makeCommand("auth.begin", { flowId: "flow-multi", sourceType: "test-auth-source" }),
    );
    const child = spawnedChildren[0];
    child.emitLine({ type: "complete", accountIds: ["item-1", "item-2", "item-3"] });
    child.endStdout();

    await waitFor(() => emitted.some((e) => e.type === "auth.complete"));

    const completes = emitted.filter((e) => e.type === "auth.complete");
    expect(completes).toHaveLength(1);
    expect(completes[0].payload).toEqual({
      flowId: "flow-multi",
      ok: true,
      accountId: "item-1",
      accountIds: ["item-1", "item-2", "item-3"],
    });
  });

  test("a widget config event is forwarded verbatim as an auth.update", async () => {
    const { handlers, emitted } = setup([authDescriptor()]);

    await handlers.handle(
      makeCommand("auth.begin", { flowId: "flow-widget", sourceType: "test-auth-source" }),
    );
    const child = spawnedChildren[0];
    child.emitLine({
      type: "widget",
      kind: "snaptrade-connect",
      payload: { link_token: "link-sandbox-abc" },
    });
    child.emitLine({ type: "complete", accountIds: ["item-1"] });
    child.endStdout();

    await waitFor(() => emitted.some((e) => e.type === "auth.complete"));

    const updates = emitted.filter((e) => e.type === "auth.update");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({
      flowId: "flow-widget",
      type: "widget",
      kind: "snaptrade-connect",
      payload: { link_token: "link-sandbox-abc" },
    });
  });

  test("auth.widget-result forwards the token + metadata to the live subprocess over stdin", async () => {
    const { handlers } = setup([authDescriptor()]);

    await handlers.handle(
      makeCommand("auth.begin", { flowId: "flow-wr", sourceType: "test-auth-source" }),
    );
    const child = spawnedChildren[0];
    await waitFor(() => child.stdinLines().length >= 1); // init line first

    const res = (await handlers.handle(
      makeCommand("auth.widget-result", {
        flowId: "flow-wr",
        token: "public-sandbox-1",
        metadata: { institution: "Example Bank" },
      }),
    )) as { ok: boolean };
    expect(res.ok).toBe(true);

    await waitFor(() =>
      child.stdinLines().some((l) => (l as { type: string }).type === "widget-result"),
    );
    expect(child.stdinLines()).toContainEqual({
      type: "widget-result",
      token: "public-sandbox-1",
      metadata: { institution: "Example Bank" },
    });
  });

  test("auth.widget-result for an unknown flow rejects", async () => {
    const { handlers } = setup([authDescriptor()]);
    await expect(
      handlers.handle(
        makeCommand("auth.widget-result", { flowId: "ghost", token: "x" }),
      ) as Promise<unknown>,
    ).rejects.toThrow(/unknown or already-finished flow/);
  });

  test("a malformed url event (missing url field) is dropped, not forwarded", async () => {
    const { handlers, emitted } = setup([authDescriptor()]);

    await handlers.handle(
      makeCommand("auth.begin", { flowId: "flow-2", sourceType: "test-auth-source" }),
    );
    const child = spawnedChildren[0];
    // `{type:"url"}` with no `url` fails per-variant validation → dropped.
    child.emitLine({ type: "url" });
    child.emitLine({ type: "qr", data: "qr-payload-abc" });
    child.emitLine({ type: "complete", accountIds: ["jamie@example.com"] });
    child.endStdout();

    await waitFor(() => emitted.some((e) => e.type === "auth.complete"));

    const updates = emitted.filter((e) => e.type === "auth.update");
    // The bad url is dropped; only the valid qr is forwarded.
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toEqual({
      flowId: "flow-2",
      type: "qr",
      data: "qr-payload-abc",
    });
  });

  test("an error event becomes a single failed auth.complete carrying the code", async () => {
    const { handlers, emitted } = setup([authDescriptor()]);

    await handlers.handle(
      makeCommand("auth.begin", { flowId: "flow-3", sourceType: "test-auth-source" }),
    );
    const child = spawnedChildren[0];
    child.emitLine({
      type: "error",
      error: "credentials required",
      code: "missing-credentials",
      fileKey: "test-provider",
      providerName: "Test",
    });
    // A second error after the terminal one must be ignored.
    child.emitLine({ type: "error", error: "second error", code: "unknown" });
    child.endStdout();

    await waitFor(() => emitted.some((e) => e.type === "auth.complete"));

    const completes = emitted.filter((e) => e.type === "auth.complete");
    expect(completes).toHaveLength(1);
    expect(completes[0].payload).toEqual({
      flowId: "flow-3",
      ok: false,
      error: "credentials required",
      code: "missing-credentials",
      fileKey: "test-provider",
      providerName: "Test",
    });
  });

  test("subprocess closing stdout with no terminal event emits code:'unknown'", async () => {
    const { handlers, emitted } = setup([authDescriptor()]);

    await handlers.handle(
      makeCommand("auth.begin", { flowId: "flow-4", sourceType: "test-auth-source" }),
    );
    const child = spawnedChildren[0];
    // A non-terminal line, then EOF — the child died mid-flow.
    child.emitLine({ type: "url", url: "https://auth.example.com/never-finished" });
    child.endStdout();

    await waitFor(() => emitted.some((e) => e.type === "auth.complete"));

    const completes = emitted.filter((e) => e.type === "auth.complete");
    expect(completes).toHaveLength(1);
    expect(completes[0].payload).toMatchObject({
      flowId: "flow-4",
      ok: false,
      code: "unknown",
    });
    // The pre-EOF url was still forwarded as an update.
    expect(emitted.filter((e) => e.type === "auth.update")).toHaveLength(1);
  });

  test("auth.begin rejects for a source with no authFlow", async () => {
    const { handlers } = setup([authDescriptor({ authFlow: undefined })]);
    // The typed dispatch wrapper is async, so a thrown handler surfaces
    // as a rejected promise rather than a synchronous throw.
    await expect(
      handlers.handle(
        makeCommand("auth.begin", { flowId: "flow-5", sourceType: "test-auth-source" }),
      ) as Promise<unknown>,
    ).rejects.toThrow(/does not support auth flow/);
    // No subprocess was spawned.
    expect(spawnedChildren).toHaveLength(0);
  });

  test("auth.begin writes the init NDJSON line carrying the flowId to the child's stdin", async () => {
    const { handlers } = setup([authDescriptor()]);
    await handlers.handle(
      makeCommand("auth.begin", { flowId: "flow-init", sourceType: "test-auth-source" }),
    );
    const child = spawnedChildren[0];
    await waitFor(() => child.stdinLines().length >= 1);
    expect(child.stdinLines()).toEqual([{ type: "init", flowId: "flow-init" }]);
    expect(childHolder.spawnCalls[0]?.options.env?.OMNESIS_CONFIG_DIR).toBe(
      "/tmp/omnesis-auth-config",
    );
  });

  test("auth.begin forwards Linux D-Bus env needed for Secret Service keyring access", async () => {
    const oldDbus = process.env.DBUS_SESSION_BUS_ADDRESS;
    const oldRuntime = process.env.XDG_RUNTIME_DIR;
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    try {
      const { handlers } = setup([authDescriptor()]);
      await handlers.handle(
        makeCommand("auth.begin", { flowId: "flow-keyring", sourceType: "test-auth-source" }),
      );
      const env = childHolder.spawnCalls[0]?.options.env;
      expect(env?.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
      expect(env?.XDG_RUNTIME_DIR).toBe("/run/user/1000");
    } finally {
      if (oldDbus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = oldDbus;
      if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = oldRuntime;
    }
  });

  test("auth.begin forwards every env key the secret store declares it reads", async () => {
    // A child that selects a backend it cannot open is the failure this
    // guards: a service installed with `--keyring-passphrase-credential`
    // inherits OMNESIS_SECRET_STORE=passphrase and then needs
    // $CREDENTIALS_DIRECTORY to find the passphrase, without which the install
    // root key never unseals and no keyring-encrypted store opens. The
    // assertion runs over the declared list so it keeps pace with it; today
    // only CREDENTIALS_DIRECTORY needs the allowlist, since the rest are
    // OMNESIS_-prefixed and ride the blanket sweep below it.
    const saved = new Map(KEYRING_ENV_KEYS.map((k) => [k, process.env[k]]));
    const oldUnrelated = process.env.AWS_SECRET_ACCESS_KEY;
    for (const key of KEYRING_ENV_KEYS) process.env[key] = `value-for-${key}`;
    process.env.AWS_SECRET_ACCESS_KEY = "unrelated-secret";
    try {
      const { handlers } = setup([authDescriptor()]);
      await handlers.handle(
        makeCommand("auth.begin", { flowId: "flow-credentials", sourceType: "test-auth-source" }),
      );
      const env = childHolder.spawnCalls[0]?.options.env;
      for (const key of KEYRING_ENV_KEYS) expect(env?.[key]).toBe(`value-for-${key}`);
      // The allowlist stays an allowlist: forwarding the keyring's own keys
      // must not start passing unrelated secret-bearing vars.
      expect(env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (oldUnrelated === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = oldUnrelated;
    }
  });

  test("auth.begin with an accountId (re-auth) carries it on the init line", async () => {
    const { handlers } = setup([authDescriptor()]);
    await handlers.handle(
      makeCommand("auth.begin", {
        flowId: "flow-reauth",
        sourceType: "test-auth-source",
        accountId: "maya@example.com",
      }),
    );
    const child = spawnedChildren[0];
    await waitFor(() => child.stdinLines().length >= 1);
    expect(child.stdinLines()).toEqual([
      { type: "init", flowId: "flow-reauth", accountId: "maya@example.com" },
    ]);
  });

  test("auth.begin with a publicBaseUrl carries it on the init line", async () => {
    const { handlers } = setup([authDescriptor()]);
    await handlers.handle(
      makeCommand("auth.begin", {
        flowId: "flow-pbu",
        sourceType: "test-auth-source",
        publicBaseUrl: "https://gw.example.com:7600",
      }),
    );
    const child = spawnedChildren[0];
    await waitFor(() => child.stdinLines().length >= 1);
    expect(child.stdinLines()).toEqual([
      { type: "init", flowId: "flow-pbu", publicBaseUrl: "https://gw.example.com:7600" },
    ]);
  });
});

describe("auth.code", () => {
  test("forwards the code as an NDJSON line on the flow's stdin", async () => {
    const { handlers } = setup([authDescriptor()]);
    await handlers.handle(
      makeCommand("auth.begin", { flowId: "flow-code", sourceType: "test-auth-source" }),
    );
    const child = spawnedChildren[0];

    const result = (await handlers.handle(
      makeCommand("auth.code", { flowId: "flow-code", code: "deli@vered/code" }),
    )) as { ok: boolean };
    expect(result.ok).toBe(true);

    await waitFor(() => child.stdinLines().length >= 2);
    expect(child.stdinLines()).toEqual([
      { type: "init", flowId: "flow-code" },
      { type: "code", code: "deli@vered/code" },
    ]);
  });

  test("rejects for an unknown flowId without faking success", async () => {
    const { handlers } = setup([authDescriptor()]);
    await expect(
      handlers.handle(
        makeCommand("auth.code", { flowId: "no-such-flow", code: "abc" }),
      ) as Promise<unknown>,
    ).rejects.toThrow(/unknown or already-finished flow/);
  });

  test("rejects after the flow finished and was removed from the active set", async () => {
    const { handlers, emitted } = setup([authDescriptor()]);
    await handlers.handle(
      makeCommand("auth.begin", { flowId: "flow-done", sourceType: "test-auth-source" }),
    );
    const child = spawnedChildren[0];
    child.emitLine({ type: "complete", accountId: "maya@example.com" });
    child.endStdout();
    await waitFor(() => emitted.some((e) => e.type === "auth.complete"));
    // The runFlowSubprocess finally-block prunes activeFlows asynchronously.
    await new Promise((r) => setImmediate(r));

    await expect(
      handlers.handle(
        makeCommand("auth.code", { flowId: "flow-done", code: "too-late" }),
      ) as Promise<unknown>,
    ).rejects.toThrow(/flow/);
  });
});
