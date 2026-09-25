// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, afterEach, vi } from "vitest";
import {
  clearSecretFileKeyCacheForTests,
  ensureInstallRootKey,
  isEncryptedSecretFile,
} from "@omnesis/core";
import { AccountId } from "@omnesis/types";
import { WhatsAppProvider, discoverAccounts, isStagingAccount, pairFlow } from "./provider.js";
import { WhatsAppMessagesSource } from "./messages.js";
import { useOmnesisMultiFileAuthState } from "./baileys-auth-state.js";
import {
  createMockSocketFactory,
  makeWAMessage,
  makeHistorySyncEvent,
  makeMessageUpsertEvent,
  type MockGroupMetadata,
} from "./testing/mock-socket.js";
import type { SocketFactory } from "./types.js";

const ME_JID = "5511999990000:0@s.whatsapp.net";
const CHAT_JID = "1234567890@s.whatsapp.net";
const GROUP_JID = "120363000000@g.us";

// Shared temp dir cleanup
const tempDirs: string[] = [];
/**
 * Pair-flow staging directories currently on disk. Their names are unique per
 * attempt, so tests assert on the set rather than on one fixed path.
 */
function stagingDirs(configDir: string): string[] {
  const waDir = join(configDir, "whatsapp");
  if (!existsSync(waDir)) return [];
  return readdirSync(waDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && isStagingAccount(d.name))
    .map((d) => d.name);
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-wa-e2e-"));
  tempDirs.push(dir);
  return dir;
}

function createPersistedPairingFactory(
  configDir: string,
  meJid: string,
  options: {
    withSessionFragment?: boolean;
    withUnexpectedFile?: boolean;
    sessionByte?: number;
  } = {},
): {
  factory: SocketFactory;
  emitter: ReturnType<typeof createMockSocketFactory>["emitter"];
  socketCreated: Promise<void>;
} {
  const mock = createMockSocketFactory({ meJid });
  let markSocketCreated!: () => void;
  const socketCreated = new Promise<void>((resolve) => {
    markSocketCreated = resolve;
  });
  return {
    emitter: mock.emitter,
    socketCreated,
    factory: {
      async createSocket(authDir) {
        if (!authDir) throw new Error("Pairing factory requires an auth directory");
        const result = await mock.factory.createSocket();
        const auth = await useOmnesisMultiFileAuthState(authDir, configDir);
        Object.assign(auth.state.creds, result.creds);
        await auth.saveCreds();
        if (options.withSessionFragment) {
          await auth.state.keys.set({
            session: { [CHAT_JID]: Uint8Array.from([options.sessionByte ?? 1, 2, 3]) },
          });
        }
        if (options.withUnexpectedFile) {
          writeFileSync(join(authDir, "unexpected.json"), "{}");
        }
        markSocketCreated();
        return {
          ...result,
          creds: auth.state.creds,
          saveCreds: auth.saveCreds,
          authDir,
        };
      },
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  tempDirs.length = 0;
  clearSecretFileKeyCacheForTests();
  vi.unstubAllEnvs();
});

/**
 * Helper: create a provider with mock socket, call authenticate() and
 * emit connection open. Returns the provider, emitter, source, and helpers.
 */
async function createConnectedProvider(opts?: {
  meJid?: string;
  meLid?: string;
  accountId?: string;
  configDir?: string;
  dataCutoff?: string;
  groupRosters?: Record<string, MockGroupMetadata>;
  groupMetadataByJid?: Record<string, MockGroupMetadata>;
  lidPnReverseMap?: Record<string, string>;
}) {
  const meJid = opts?.meJid ?? ME_JID;
  const accountId = opts?.accountId ?? "+5511999990000";
  const configDir = opts?.configDir ?? makeTempDir();

  // Create auth dir so the provider doesn't fail on missing directory
  mkdirSync(join(configDir, "whatsapp", accountId, "auth"), { recursive: true });

  const { factory, emitter, endCalled, groupCalls, resyncCalls, lidLookupCalls } =
    createMockSocketFactory({
      meJid,
      meLid: opts?.meLid,
      groupRosters: opts?.groupRosters,
      groupMetadataByJid: opts?.groupMetadataByJid,
      lidPnReverseMap: opts?.lidPnReverseMap,
    });
  const provider = new WhatsAppProvider(accountId, configDir, factory);
  await provider.initialize();

  // Start authenticate() — it will wait for "connection.update { connection: open }"
  const authPromise = provider.authenticate();

  // Let the promise body register listeners
  await new Promise((r) => setTimeout(r, 0));

  // Emit connection open
  emitter.emit("connection.update", { connection: "open" });
  await authPromise;

  const store = provider.getStore();
  const source = new WhatsAppMessagesSource(store, accountId, {
    dataCutoff: opts?.dataCutoff,
  });

  return {
    provider,
    emitter,
    endCalled,
    store,
    source,
    configDir,
    groupCalls,
    resyncCalls,
    lidLookupCalls,
  };
}

// ---------------------------------------------------------------------------
// Group 1: Provider Connection Lifecycle
// ---------------------------------------------------------------------------
describe("Provider Connection Lifecycle", () => {
  test("connects successfully via mock socket factory", async () => {
    const { provider } = await createConnectedProvider();
    // If we get here, authenticate() resolved — connection succeeded
    expect(provider.accountId).toBe(AccountId("+5511999990000"));
    await provider.disconnect();
  });

  test("resolves account ID from JID when accountId is _pairing", async () => {
    const configDir = makeTempDir();
    mkdirSync(join(configDir, "whatsapp", "_pairing", "auth"), { recursive: true });

    const { factory, emitter } = createMockSocketFactory({
      meJid: "5599887766:0@s.whatsapp.net",
    });
    const provider = new WhatsAppProvider("_pairing", configDir, factory);
    await provider.initialize();

    const authPromise = provider.authenticate();
    await new Promise((r) => setTimeout(r, 0));
    emitter.emit("connection.update", { connection: "open" });
    await authPromise;

    expect(provider.accountId).toBe(AccountId("+5599887766"));
    await provider.disconnect();
  });

  test("disconnect calls sock.end", async () => {
    const { provider, endCalled } = await createConnectedProvider();
    expect(endCalled()).toBe(false);
    await provider.disconnect();
    expect(endCalled()).toBe(true);
  });

  test("disconnect ends a socket whose factory resolves after teardown", async () => {
    const configDir = makeTempDir();
    const accountId = "+447700900126";
    mkdirSync(join(configDir, "whatsapp", accountId, "auth"), { recursive: true });
    const mock = createMockSocketFactory({ meJid: "447700900126:0@s.whatsapp.net" });
    let markFactoryStarted!: () => void;
    const factoryStarted = new Promise<void>((resolve) => {
      markFactoryStarted = resolve;
    });
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    let markEndStarted!: () => void;
    const endStarted = new Promise<void>((resolve) => {
      markEndStarted = resolve;
    });
    let releaseEnd!: () => void;
    const endGate = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    const factory: SocketFactory = {
      async createSocket() {
        markFactoryStarted();
        await factoryGate;
        const result = await mock.factory.createSocket();
        return {
          ...result,
          sock: {
            ...result.sock,
            async end(reason?: unknown) {
              markEndStarted();
              await endGate;
              result.sock.end(reason);
            },
          },
        };
      },
    };
    const provider = new WhatsAppProvider(accountId, configDir, factory);
    await provider.initialize();

    const authentication = provider.authenticate();
    let authenticationSettled = false;
    void authentication.then(
      () => {
        authenticationSettled = true;
      },
      () => {
        authenticationSettled = true;
      },
    );
    await factoryStarted;
    await provider.disconnect();
    releaseFactory();
    await endStarted;
    expect(authenticationSettled).toBe(false);
    releaseEnd();

    await expect(authentication).rejects.toThrow("WhatsApp connection was cancelled");
    expect(mock.endCalled()).toBe(true);
  });

  // Regression: disconnect() must short-circuit the auto-reconnect loop,
  // otherwise `cli remove whatsapp-messages:<phone>` would race with
  // `cleanupCredentials` rmSync'ing the auth dir — Baileys's reconnect
  // would re-create then try to write into a dir that's about to be (or
  // just was) deleted, emitting `ENOENT: ... creds.json` every ~30s
  // until the next collector restart. Closes the dangling-timer half of
  // cli-remove-toctou-leaves-orphan-state.
  test("disconnect prevents auto-reconnect on subsequent close events", async () => {
    const configDir = makeTempDir();
    mkdirSync(join(configDir, "whatsapp", "+5511999990000", "auth"), { recursive: true });

    const { factory, emitter, createSocketCount } = createMockSocketFactory({
      meJid: ME_JID,
    });
    const provider = new WhatsAppProvider("+5511999990000", configDir, factory);
    await provider.initialize();

    const authPromise = provider.authenticate();
    await new Promise((r) => setTimeout(r, 0));
    emitter.emit("connection.update", { connection: "open" });
    await authPromise;

    expect(createSocketCount()).toBe(1);

    // disconnect() flips shuttingDown BEFORE sock.end(); the connection
    // close event the engine fires next must NOT spawn a new socket.
    await provider.disconnect();

    // Simulate Baileys's post-shutdown close fan-out (a normal disconnect
    // sequence emits this). With shuttingDown set, no new socket should be
    // created — without the fix, this would re-invoke startSocket() and
    // bump the counter, racing cleanupCredentials.
    emitter.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(createSocketCount()).toBe(1);
  });

  // Disabling a push source must stop its connection (suspend), not leave the
  // reconnect loop running headless — otherwise a re-enable stacks a second
  // socket that fights the first for the one allowed device connection (the
  // mutual-428 storm). suspend() stops the loop; resume() brings back exactly
  // one socket.
  test("suspend stops the reconnect loop; resume re-establishes one connection", async () => {
    const configDir = makeTempDir();
    mkdirSync(join(configDir, "whatsapp", "+5511999990000", "auth"), { recursive: true });

    const { factory, emitter, createSocketCount, endCalled } = createMockSocketFactory({
      meJid: ME_JID,
    });
    const provider = new WhatsAppProvider("+5511999990000", configDir, factory);
    await provider.initialize();

    const authPromise = provider.authenticate();
    await new Promise((r) => setTimeout(r, 0));
    emitter.emit("connection.update", { connection: "open" });
    await authPromise;
    expect(createSocketCount()).toBe(1);

    // Suspend (source disabled): the socket is closed and the loop stops.
    await provider.suspend();
    expect(endCalled()).toBe(true);

    // A post-suspend close must NOT spawn a reconnect.
    emitter.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 503 } } },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(createSocketCount()).toBe(1);

    // Resume (source re-enabled): exactly one fresh socket is created.
    await provider.resume();
    await new Promise((r) => setTimeout(r, 0));
    emitter.emit("connection.update", { connection: "open" });
    expect(createSocketCount()).toBe(2);

    await provider.disconnect();
  });

  // Regression: Baileys' `sock.end()` flushes its close event asynchronously,
  // so a socket torn down by suspend can fire a *late* close after resume has
  // already cleared `shuttingDown`. Without the connection-generation guard the
  // stale closure would treat that as a transient drop and reconnect, stacking
  // a second socket that fights the live one (mutual 428 eviction).
  test("a stale socket's late close after resume does not resurrect a second socket", async () => {
    const configDir = makeTempDir();
    mkdirSync(join(configDir, "whatsapp", "+5511999990000", "auth"), { recursive: true });

    const { factory, emitter, createSocketCount } = createMockSocketFactory({
      meJid: ME_JID,
    });
    const provider = new WhatsAppProvider("+5511999990000", configDir, factory);
    await provider.initialize();

    // Capture each connection.update handler the provider registers so we can
    // fire ONLY the old socket's handler (the mock shares one emitter across
    // sockets, unlike real Baileys where each socket has its own `ev`).
    const updateHandlers: Array<(u: Record<string, unknown>) => void> = [];
    const origOn = emitter.on.bind(emitter);
    vi.spyOn(emitter, "on").mockImplementation(((
      event: string,
      listener: (...a: any[]) => void,
    ) => {
      if (event === "connection.update") updateHandlers.push(listener);
      return origOn(event, listener);
    }) as any);

    const authPromise = provider.authenticate();
    await new Promise((r) => setTimeout(r, 0));
    emitter.emit("connection.update", { connection: "open" });
    await authPromise;
    expect(createSocketCount()).toBe(1);
    expect(updateHandlers).toHaveLength(1); // the now-stale (gen-1) handler

    // Disable then re-enable: suspend tears the socket down, resume brings up a
    // fresh one (a new generation + handler).
    await provider.suspend();
    await provider.resume();
    await new Promise((r) => setTimeout(r, 0));
    emitter.emit("connection.update", { connection: "open" });
    expect(createSocketCount()).toBe(2);
    expect(updateHandlers.length).toBeGreaterThanOrEqual(2);

    // The OLD socket's deferred close finally lands. shuttingDown is false again
    // (resume cleared it) — only the generation guard stops the stale closure
    // from scheduling a reconnect.
    const before = createSocketCount();
    updateHandlers[0]({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(createSocketCount()).toBe(before); // no resurrection

    await provider.disconnect();
  });

  // A source re-enabled while WhatsApp is briefly unreachable must self-heal,
  // not die: the resumed connection's first reconnect burst can exhaust the cap
  // without ever opening, and that must schedule a cool-down rather than reject
  // (the create-time-only reject would otherwise leave a re-enabled source dead).
  test("a resumed source that can't reconnect self-heals via cool-down, not death", async () => {
    const configDir = makeTempDir();
    mkdirSync(join(configDir, "whatsapp", "+5511999990000", "auth"), { recursive: true });

    const realSetTimeout = globalThis.setTimeout;
    const pendingTimers: Array<{ fn: () => void; ms: number }> = [];
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      pendingTimers.push({ fn, ms });
      return 0;
    }) as any;
    const COOLDOWN_MS = 5 * 60_000;

    try {
      const { factory, emitter } = createMockSocketFactory({ meJid: ME_JID });
      const provider = new WhatsAppProvider("+5511999990000", configDir, factory);
      await provider.initialize();

      const errors: string[] = [];
      provider.onConnectionError((err) => errors.push(err));

      // Establish, then disable.
      const authPromise = provider.authenticate();
      await Promise.resolve();
      emitter.emit("connection.update", { connection: "open" });
      await authPromise;
      await provider.suspend();

      // Re-enable, but the resumed connection never opens.
      await provider.resume();
      await Promise.resolve();

      const emitClose = async () => {
        emitter.emit("connection.update", {
          connection: "close",
          lastDisconnect: { error: { output: { statusCode: 503 } } },
        });
        await Promise.resolve();
      };
      for (let i = 0; i < 10; i++) await emitClose();
      pendingTimers.length = 0;

      // The cap close on a never-opened resume must cool-down (self-heal), not
      // reject/die — surfacing the error once and scheduling one cool-down timer.
      await emitClose();
      expect(errors.length).toBe(1);
      expect(errors[0]).toMatch(/reconnect failed after 10 attempts/);
      expect(pendingTimers).toHaveLength(1);
      expect(pendingTimers[0].ms).toBe(COOLDOWN_MS);

      globalThis.setTimeout = realSetTimeout;
      await provider.disconnect();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("handles loggedOut disconnect by rejecting authenticate", async () => {
    const configDir = makeTempDir();
    mkdirSync(join(configDir, "whatsapp", "+1234", "auth"), { recursive: true });

    const { factory, emitter } = createMockSocketFactory({
      meJid: "1234:0@s.whatsapp.net",
    });
    const provider = new WhatsAppProvider("+1234", configDir, factory);
    await provider.initialize();

    const authPromise = provider.authenticate();
    await new Promise((r) => setTimeout(r, 0));

    // Emit a "close" with statusCode 401 (loggedOut) and creds.me set
    emitter.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: {
          output: { statusCode: 401 },
        },
      },
    });

    await expect(authPromise).rejects.toThrow("WhatsApp logged out");
  });

  // Reconnect-loop hardening.
  test("transient close after open does not reconnect immediately — backoff applies", async () => {
    const configDir = makeTempDir();
    mkdirSync(join(configDir, "whatsapp", "+5511999990000", "auth"), { recursive: true });

    const { factory, emitter, createSocketCount } = createMockSocketFactory({
      meJid: ME_JID,
    });
    const provider = new WhatsAppProvider("+5511999990000", configDir, factory);
    await provider.initialize();

    const authPromise = provider.authenticate();
    await new Promise((r) => setTimeout(r, 0));
    emitter.emit("connection.update", { connection: "open" });
    await authPromise;

    expect(createSocketCount()).toBe(1);

    // Emit a transient close (5xx). The pre-fix code re-invoked
    // startSocket() inline; the post-fix code schedules a reconnect via
    // setTimeout(>=1.5s). 100ms is well under the minimum jittered base
    // delay (2s ± 25% → ≥1500ms), so no new socket should appear yet.
    emitter.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 503 } } },
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(createSocketCount()).toBe(1);

    await provider.disconnect();
  });

  test("reconnect cap surfaces failure once, then self-heals on cool-down retry", async () => {
    const configDir = makeTempDir();
    mkdirSync(join(configDir, "whatsapp", "+5511999990000", "auth"), { recursive: true });

    // Stub setTimeout so backoff/cool-down timers are captured, not fired in
    // real time. We deliberately do NOT fire the per-attempt reconnect timers:
    // re-creating sockets would accumulate listeners on the mock's shared
    // emitter and corrupt attempt counting. Driving every close through the
    // initial socket's handler still increments the (closure-scoped) attempt
    // counter exactly once per close, which is all the cap logic needs.
    const realSetTimeout = globalThis.setTimeout;
    const pendingTimers: Array<{ fn: () => void; ms: number }> = [];
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      pendingTimers.push({ fn, ms });
      return 0;
    }) as any;
    // Mirrors WhatsAppProvider.RECONNECT_COOLDOWN_MS — distinct from the fast
    // backoff band, which is capped at RECONNECT_MAX_MS (60s).
    const COOLDOWN_MS = 5 * 60_000;

    try {
      const { factory, emitter, createSocketCount } = createMockSocketFactory({
        meJid: ME_JID,
      });
      const provider = new WhatsAppProvider("+5511999990000", configDir, factory);
      await provider.initialize();

      const errors: string[] = [];
      provider.onConnectionError((err) => errors.push(err));

      const authPromise = provider.authenticate();
      await Promise.resolve();
      emitter.emit("connection.update", { connection: "open" });
      await authPromise;
      expect(createSocketCount()).toBe(1);

      const emitClose = async () => {
        emitter.emit("connection.update", {
          connection: "close",
          lastDisconnect: { error: { output: { statusCode: 503 } } },
        });
        await Promise.resolve();
      };

      // Closes 1..10 stay within the cap — no error surfaced yet.
      for (let i = 0; i < 10; i++) await emitClose();
      expect(errors.length).toBe(0);

      // Drop the fast-backoff + open-time history-settle timers so the only timer
      // the cap close schedules is the one we assert on.
      pendingTimers.length = 0;

      // The 11th close exceeds the cap: the failure is surfaced ONCE, but the
      // provider does NOT give up — it schedules exactly one *cool-down* retry
      // (5 min, distinct from the ≤60s fast band). The old code scheduled
      // nothing here and the source stayed dead, so this is the regression guard.
      await emitClose();
      expect(errors.length).toBe(1);
      expect(errors[0]).toMatch(/reconnect failed after 10 attempts/);
      expect(pendingTimers).toHaveLength(1);
      expect(pendingTimers[0].ms).toBe(COOLDOWN_MS);

      // Firing the cool-down creates a fresh socket — the provider keeps trying.
      const before = createSocketCount();
      pendingTimers[0].fn();
      await Promise.resolve();
      await Promise.resolve();
      expect(createSocketCount()).toBe(before + 1);

      // A successful reconnect recovers the source: wakeSync pokes a sync so the
      // source leaves `error` even when no new message arrives, and no second
      // error is surfaced.
      const wake = vi.spyOn(provider.getStore(), "wakeSync");
      emitter.emit("connection.update", { connection: "open" });
      await Promise.resolve();
      expect(errors.length).toBe(1);
      expect(wake).toHaveBeenCalled();

      // Restore real timers before disconnect — it awaits a timer-backed
      // credential-flush wait that the stub would never fire.
      globalThis.setTimeout = realSetTimeout;
      await provider.disconnect();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  // Regression: a createSocket() throw on a *reconnect* attempt (transient
  // FS error in useMultiFileAuthState, makeWASocket failure) must not stall
  // the loop. The buggy catch called `scheduleReconnect()` with no runner —
  // the timer fired, saw `runner` undefined, and no-op'd, so the socket was
  // never re-created and the source went permanently silent with no error
  // surfaced. The fix counts the throw as a failed attempt and reschedules
  // with `startSocket` as the runner.
  test("createSocket throw during reconnect retries instead of stalling", async () => {
    const configDir = makeTempDir();
    mkdirSync(join(configDir, "whatsapp", "+5511999990000", "auth"), { recursive: true });

    // Throw only on the FIRST reconnect attempt (createSocket call #2); the
    // initial connect (#1) and the following retry (#3) succeed.
    const { factory, emitter, createSocketCount } = createMockSocketFactory({
      meJid: ME_JID,
      throwOnCreateSocket: (n) => (n === 2 ? new Error("transient auth-dir read error") : null),
    });
    const provider = new WhatsAppProvider("+5511999990000", configDir, factory);
    await provider.initialize();

    const authPromise = provider.authenticate();
    await new Promise((r) => setTimeout(r, 0));
    emitter.emit("connection.update", { connection: "open" });
    await authPromise;
    expect(createSocketCount()).toBe(1);

    // Stub setTimeout so the backoff timers fire synchronously when drained.
    const realSetTimeout = globalThis.setTimeout;
    const pendingTimers: Array<() => void> = [];
    globalThis.setTimeout = ((fn: () => void, _ms: number) => {
      pendingTimers.push(fn);
      return 0;
    }) as any;

    try {
      // Transient close → schedules the first reconnect (createSocket call #2,
      // which throws).
      emitter.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 503 } } },
      });

      // Drain a few rounds of backoff timers. Post-fix: call #2 throws, the
      // catch reschedules, call #3 succeeds. Pre-fix: the no-runner timer
      // no-ops and call #2 is never re-attempted — the loop stalls at 2.
      for (let round = 0; round < 5 && pendingTimers.length > 0; round++) {
        const fn = pendingTimers.shift()!;
        fn();
        await Promise.resolve();
        await Promise.resolve();
      }
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // The loop survived the createSocket throw and re-created the socket.
    // Pre-fix this stays at 2 (stalled); post-fix it reaches 3.
    expect(createSocketCount()).toBeGreaterThanOrEqual(3);

    await provider.disconnect();
  });

  // Regression: a *persistent* createSocket() failure during reconnect must
  // eventually surface to onConnectionError via the attempt cap rather than
  // dying silently. The buggy catch never incremented reconnectAttempts, so
  // the cap (and thus the error handler) was unreachable on this path.
  test("persistent createSocket throw during reconnect surfaces onConnectionError", async () => {
    const configDir = makeTempDir();
    mkdirSync(join(configDir, "whatsapp", "+5511999990000", "auth"), { recursive: true });

    // Succeed on the initial connect (#1), throw on every reconnect after.
    const { factory, emitter, createSocketCount } = createMockSocketFactory({
      meJid: ME_JID,
      throwOnCreateSocket: (n) => (n >= 2 ? new Error("persistent auth-dir read error") : null),
    });
    const provider = new WhatsAppProvider("+5511999990000", configDir, factory);
    await provider.initialize();

    const errors: string[] = [];
    provider.onConnectionError((err) => errors.push(err));

    const authPromise = provider.authenticate();
    await new Promise((r) => setTimeout(r, 0));
    emitter.emit("connection.update", { connection: "open" });
    await authPromise;
    expect(createSocketCount()).toBe(1);

    const realSetTimeout = globalThis.setTimeout;
    const pendingTimers: Array<() => void> = [];
    globalThis.setTimeout = ((fn: () => void, _ms: number) => {
      pendingTimers.push(fn);
      return 0;
    }) as any;

    try {
      emitter.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 503 } } },
      });
      // Drain every rescheduled timer. Post-fix the loop walks the 10-attempt
      // cap then fires onConnectionError. Pre-fix the first timer no-ops and
      // nothing else is ever scheduled.
      let guard = 0;
      while (pendingTimers.length > 0 && guard++ < 100) {
        const fn = pendingTimers.shift()!;
        fn();
        await Promise.resolve();
        await Promise.resolve();
      }
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/reconnect failed after 10 attempts/);

    await provider.disconnect();
  });

  test("disconnect cancels a pending reconnect timer (no socket re-creation)", async () => {
    const configDir = makeTempDir();
    mkdirSync(join(configDir, "whatsapp", "+5511999990000", "auth"), { recursive: true });

    const { factory, emitter, createSocketCount } = createMockSocketFactory({
      meJid: ME_JID,
    });
    const provider = new WhatsAppProvider("+5511999990000", configDir, factory);
    await provider.initialize();

    const authPromise = provider.authenticate();
    await new Promise((r) => setTimeout(r, 0));
    emitter.emit("connection.update", { connection: "open" });
    await authPromise;

    expect(createSocketCount()).toBe(1);

    // Trigger a transient close — schedules a backoff timer.
    emitter.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 503 } } },
    });
    // disconnect() flips shuttingDown AND clears the reconnect timer; no
    // additional socket should be created even after several seconds.
    await provider.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    expect(createSocketCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Group 2: History Sync → Full Pipeline
// ---------------------------------------------------------------------------
describe("History Sync → Full Pipeline", () => {
  test("history sync produces DocumentInput via source", async () => {
    const { emitter, source } = await createConnectedProvider();

    const ts = 1709900000; // 2024-03-08
    emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [
          makeWAMessage({ id: "m1", remoteJid: CHAT_JID, text: "Hey!", timestamp: ts }),
          makeWAMessage({
            id: "m2",
            remoteJid: CHAT_JID,
            text: "How are you?",
            timestamp: ts + 60,
          }),
        ],
        chats: [{ id: CHAT_JID, name: "Alice" }],
        contacts: [{ id: CHAT_JID, name: "Alice" }],
        isLatest: true,
      }),
    );

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);

    const doc = result.documents[0];
    expect(doc.externalId).toBe(`${CHAT_JID}:2024-03-08`);
    expect(doc.content).toContain("Hey!");
    expect(doc.content).toContain("How are you?");
    expect(doc.metadata.documentType).toBe("conversation");
  });

  test("multi-batch history accumulates into single document per day-chat", async () => {
    const { emitter, source } = await createConnectedProvider();

    const ts = 1709900000;
    // First batch
    emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [
          makeWAMessage({ id: "m1", remoteJid: CHAT_JID, text: "Batch 1", timestamp: ts }),
        ],
        chats: [{ id: CHAT_JID, name: "Alice" }],
        isLatest: false,
      }),
    );

    // Second batch (same chat, same day)
    emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [
          makeWAMessage({ id: "m2", remoteJid: CHAT_JID, text: "Batch 2", timestamp: ts + 60 }),
        ],
        isLatest: true,
      }),
    );

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].content).toContain("Batch 1");
    expect(result.documents[0].content).toContain("Batch 2");
  });

  test("different chats produce separate documents", async () => {
    const { emitter, source } = await createConnectedProvider();

    const ts = 1709900000;
    emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [
          makeWAMessage({ id: "m1", remoteJid: CHAT_JID, text: "From Alice", timestamp: ts }),
          makeWAMessage({ id: "m2", remoteJid: GROUP_JID, text: "From group", timestamp: ts }),
        ],
        chats: [
          { id: CHAT_JID, name: "Alice" },
          { id: GROUP_JID, name: "Test Group" },
        ],
        isLatest: true,
      }),
    );

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(2);

    const externalIds = result.documents.map((d) => d.externalId);
    expect(externalIds).toContain(`${CHAT_JID}:2024-03-08`);
    expect(externalIds).toContain(`${GROUP_JID}:2024-03-08`);
  });

  test("isLatest sets historySyncComplete and phase becomes incremental", async () => {
    const { emitter, source, store } = await createConnectedProvider();

    emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [makeWAMessage({ id: "m1", remoteJid: CHAT_JID, timestamp: 1709900000 })],
        isLatest: true,
      }),
    );

    expect(store.historySyncComplete).toBe(true);

    const result = await source.sync(null);
    const cursor = result.cursor as any;
    expect(cursor.phase).toBe("incremental");
    expect(typeof cursor.committedSeq).toBe("number");
    expect(result.hasMore).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 3: Real-Time Messages → Full Pipeline
// ---------------------------------------------------------------------------
describe("Real-Time Messages → Full Pipeline", () => {
  test("real-time upsert produces document", async () => {
    const { emitter, source, store } = await createConnectedProvider();

    // Mark history complete so we're in incremental mode
    store.setHistorySyncState("complete");

    const ts = 1709900000;
    emitter.emit(
      "messages.upsert",
      makeMessageUpsertEvent([
        makeWAMessage({ id: "rt1", remoteJid: CHAT_JID, text: "Real-time msg", timestamp: ts }),
      ]),
    );

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].content).toContain("Real-time msg");
  });

  test("append upserts (offline-queue delivery) produce documents", async () => {
    const { emitter, source, store } = await createConnectedProvider();
    store.setHistorySyncState("complete");

    // Baileys tags messages WhatsApp queued while the companion was offline
    // as "append" when it delivers them on reconnect — they must be stored
    // exactly like real-time "notify" messages.
    emitter.emit(
      "messages.upsert",
      makeMessageUpsertEvent(
        [
          makeWAMessage({
            id: "rt1",
            remoteJid: CHAT_JID,
            text: "Sent while collector was down",
            timestamp: 1709900000,
          }),
        ],
        "append",
      ),
    );

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].content).toContain("Sent while collector was down");
  });

  test("onPushEvent fires on message arrival", async () => {
    const { emitter, source } = await createConnectedProvider();

    let pushFired = false;
    source.onPushEvent(() => {
      pushFired = true;
    });

    emitter.emit(
      "messages.upsert",
      makeMessageUpsertEvent([
        makeWAMessage({ id: "rt1", remoteJid: CHAT_JID, timestamp: 1709900000 }),
      ]),
    );

    expect(pushFired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 4: Message Deletion
// ---------------------------------------------------------------------------
describe("Message Deletion", () => {
  test("deleted messages (messageStubType=1) excluded from sync", async () => {
    const { emitter, source, store } = await createConnectedProvider();
    store.setHistorySyncState("complete");

    const ts = 1709900000;
    // Add messages via history
    emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [
          makeWAMessage({ id: "keep", remoteJid: CHAT_JID, text: "Keep me", timestamp: ts }),
          makeWAMessage({ id: "del", remoteJid: CHAT_JID, text: "Delete me", timestamp: ts + 60 }),
        ],
        isLatest: true,
      }),
    );

    // Delete one message
    emitter.emit("messages.update", [
      {
        key: { id: "del", remoteJid: CHAT_JID },
        update: { messageStubType: 1 },
      },
    ]);

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].content).toContain("Keep me");
    expect(result.documents[0].content).not.toContain("Delete me");
  });

  test("status=5 (PLAYED) does NOT delete a played voice note", async () => {
    // WAMessageStatus 5 is PLAYED — the receipt emitted once a voice note is
    // listened to — not a deletion. A played voice note must stay in the doc.
    const { emitter, source, store } = await createConnectedProvider();
    store.setHistorySyncState("complete");

    const ts = 1709900000;
    emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [
          makeWAMessage({ id: "keep", remoteJid: CHAT_JID, text: "Visible", timestamp: ts }),
          makeWAMessage({
            id: "voice",
            remoteJid: CHAT_JID,
            timestamp: ts + 60,
            message: { audioMessage: { ptt: true, seconds: 6 } },
          }),
        ],
        isLatest: true,
      }),
    );

    // The recipient plays the voice note → Baileys emits status: 5 (PLAYED).
    emitter.emit("messages.update", [
      {
        key: { id: "voice", remoteJid: CHAT_JID },
        update: { status: 5 },
      },
    ]);

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].content).toContain("Visible");
    expect(result.documents[0].content).toContain("Voice note");
  });
});

// ---------------------------------------------------------------------------
// Group 5: Account Discovery
// ---------------------------------------------------------------------------
describe("Account Discovery", () => {
  test("finds accounts with valid creds", () => {
    const configDir = makeTempDir();
    const authDir = join(configDir, "whatsapp", "+1234567890", "auth");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(
      join(authDir, "creds.json"),
      JSON.stringify({ me: { id: "1234567890:0@s.whatsapp.net" } }),
    );

    const accounts = discoverAccounts(configDir);
    expect(accounts).toEqual([AccountId("+1234567890")]);
  });

  test("ignores underscore-prefixed dirs", () => {
    const configDir = makeTempDir();
    const authDir = join(configDir, "whatsapp", "_pairing", "auth");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "creds.json"), "{}");

    const accounts = discoverAccounts(configDir);
    expect(accounts).toEqual([]);
  });

  test("ignores dirs without creds.json", () => {
    const configDir = makeTempDir();
    mkdirSync(join(configDir, "whatsapp", "+1234567890", "auth"), { recursive: true });
    // No creds.json

    const accounts = discoverAccounts(configDir);
    expect(accounts).toEqual([]);
  });

  test("handles missing whatsapp directory", () => {
    const configDir = makeTempDir();
    // No whatsapp dir at all

    const accounts = discoverAccounts(configDir);
    expect(accounts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Group 6: Pairing Flow
// ---------------------------------------------------------------------------
describe("Pairing Flow", () => {
  test("encrypted pairing remains authenticated after account-directory promotion", async () => {
    const configDir = makeTempDir();
    vi.stubEnv("OMNESIS_SECRET_STORE", "file");
    clearSecretFileKeyCacheForTests();
    await ensureInstallRootKey({ backend: "file", configDir });

    const pairing = createPersistedPairingFactory(configDir, "447700900123:0@s.whatsapp.net", {
      withSessionFragment: true,
    });
    const flowPromise = pairFlow(configDir, pairing.factory);
    await pairing.socketCreated;
    await new Promise((resolve) => setTimeout(resolve, 0));
    pairing.emitter.emit("connection.update", { connection: "open" });

    const accountId = await flowPromise;
    const credsPath = join(configDir, "whatsapp", accountId, "auth", "creds.json");
    expect(isEncryptedSecretFile(readFileSync(credsPath, "utf8"))).toBe(true);

    const reopened = new WhatsAppProvider(accountId, configDir, pairing.factory);
    try {
      expect(await reopened.isAuthenticated()).toBe(true);
      const auth = await useOmnesisMultiFileAuthState(
        join(configDir, "whatsapp", accountId, "auth"),
        configDir,
      );
      const sessions = await auth.state.keys.get("session", [CHAT_JID]);
      expect(Array.from(sessions[CHAT_JID])).toEqual([1, 2, 3]);
    } finally {
      await reopened.disconnect();
    }
  });

  test("failed promotion retains staged credentials and hides permanent account", async () => {
    const configDir = makeTempDir();
    vi.stubEnv("OMNESIS_SECRET_STORE", "file");
    clearSecretFileKeyCacheForTests();
    await ensureInstallRootKey({ backend: "file", configDir });
    const accountId = "+447700900127";
    const pairing = createPersistedPairingFactory(configDir, "447700900127:0@s.whatsapp.net", {
      withUnexpectedFile: true,
    });
    const flowPromise = pairFlow(configDir, pairing.factory);
    await pairing.socketCreated;
    await new Promise((resolve) => setTimeout(resolve, 0));
    pairing.emitter.emit("connection.update", { connection: "open" });

    // The refusal names the offending file, so an operator can see which
    // entry stopped the pairing rather than being told only that one did.
    await expect(flowPromise).rejects.toThrow(
      "WhatsApp auth state cannot be promoted — unexpected.json: not a recognised auth file",
    );
    const [stagingAccount] = stagingDirs(configDir);
    expect(stagingAccount).toBeDefined();
    expect(
      isEncryptedSecretFile(
        readFileSync(join(configDir, "whatsapp", stagingAccount, "auth", "creds.json"), "utf8"),
      ),
    ).toBe(true);
    expect(existsSync(join(configDir, "whatsapp", accountId, "auth", "creds.json"))).toBe(false);
  });

  test("failed plaintext promotion removes staged credentials", async () => {
    const configDir = makeTempDir();
    vi.stubEnv("OMNESIS_SECRET_STORE", "file");
    clearSecretFileKeyCacheForTests();
    const pairing = createPersistedPairingFactory(configDir, "447700900128:0@s.whatsapp.net", {
      withUnexpectedFile: true,
    });
    const flowPromise = pairFlow(configDir, pairing.factory);
    await pairing.socketCreated;
    await new Promise((resolve) => setTimeout(resolve, 0));
    pairing.emitter.emit("connection.update", { connection: "open" });

    // The refusal names the offending file, so an operator can see which
    // entry stopped the pairing rather than being told only that one did.
    await expect(flowPromise).rejects.toThrow(
      "WhatsApp auth state cannot be promoted — unexpected.json: not a recognised auth file",
    );
    expect(stagingDirs(configDir)).toEqual([]);
  });

  test("pairFlow preserves source-owned files while replacing credentials", async () => {
    const configDir = makeTempDir();
    const accountId = "+447700900124";
    const accountDir = join(configDir, "whatsapp", accountId);
    mkdirSync(accountDir, { recursive: true });
    const retainedPath = join(accountDir, "store.db");
    writeFileSync(retainedPath, "keep");

    const pairing = createPersistedPairingFactory(configDir, "447700900124:0@s.whatsapp.net");
    const flowPromise = pairFlow(configDir, pairing.factory);
    await pairing.socketCreated;
    await new Promise((resolve) => setTimeout(resolve, 0));
    pairing.emitter.emit("connection.update", { connection: "open" });

    expect(await flowPromise).toBe(AccountId(accountId));
    expect(readFileSync(retainedPath, "utf8")).toBe("keep");
  });

  test("renewal refuses a different phone before promoting its credentials", async () => {
    const configDir = makeTempDir();
    const expectedAccountId = "+447700900131";
    const resolvedAccountId = "+447700900132";
    const retained = join(configDir, "whatsapp", expectedAccountId, "auth");
    mkdirSync(retained, { recursive: true });
    writeFileSync(join(retained, "creds.json"), "unchanged");
    const pairing = createPersistedPairingFactory(configDir, "447700900132:0@s.whatsapp.net");
    const flow = pairFlow({ configDir, expectedAccountId, socketFactory: pairing.factory });
    const refused = expect(flow).rejects.toMatchObject({ code: "identity-mismatch" });
    await pairing.socketCreated;
    await new Promise((resolve) => setTimeout(resolve, 0));
    pairing.emitter.emit("connection.update", { connection: "open" });
    await refused;
    expect(readFileSync(join(retained, "creds.json"), "utf8")).toBe("unchanged");
    expect(existsSync(join(configDir, "whatsapp", resolvedAccountId))).toBe(false);
    expect(stagingDirs(configDir)).toEqual([]);
  });

  test("pairFlow resolves phone and renames directory", async () => {
    const configDir = makeTempDir();

    const pairing = createPersistedPairingFactory(configDir, "5511888880000:0@s.whatsapp.net");
    const flowPromise = pairFlow(configDir, pairing.factory);
    await pairing.socketCreated;
    await new Promise((resolve) => setTimeout(resolve, 0));
    pairing.emitter.emit("connection.update", { connection: "open" });

    const phone = await flowPromise;
    expect(phone).toBe(AccountId("+5511888880000"));

    // The staging directory is promoted, not left behind. Its name is unique
    // per attempt, so assert no staging directory survives rather than probing
    // one fixed path — which would pass vacuously.
    expect(stagingDirs(configDir)).toEqual([]);
    expect(existsSync(join(configDir, "whatsapp", "+5511888880000"))).toBe(true);
  });

  test("concurrent pair flows for one account serialize permanent promotion", async () => {
    const configDir = makeTempDir();
    const first = createPersistedPairingFactory(configDir, "447700900125:0@s.whatsapp.net", {
      withSessionFragment: true,
      sessionByte: 1,
    });
    const second = createPersistedPairingFactory(configDir, "447700900125:0@s.whatsapp.net", {
      withSessionFragment: true,
      sessionByte: 2,
    });

    const firstFlow = pairFlow(configDir, first.factory);
    const secondFlow = pairFlow(configDir, second.factory);
    await Promise.all([first.socketCreated, second.socketCreated]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.emitter.emit("connection.update", { connection: "open" });
    await new Promise((resolve) => setTimeout(resolve, 1));
    second.emitter.emit("connection.update", { connection: "open" });

    const results = await Promise.allSettled([firstFlow, secondFlow]);
    const accounts = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(accounts.length).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ name: "WhatsAppPairingSupersededError" });
      }
    }
    expect(stagingDirs(configDir)).toEqual([]);
    const reopened = new WhatsAppProvider(accounts[0], configDir, second.factory);
    try {
      expect(await reopened.isAuthenticated()).toBe(true);
      const auth = await useOmnesisMultiFileAuthState(
        join(configDir, "whatsapp", accounts[0], "auth"),
        configDir,
      );
      const sessions = await auth.state.keys.get("session", [CHAT_JID]);
      expect(Array.from(sessions[CHAT_JID])).toEqual([2, 2, 3]);
    } finally {
      await reopened.disconnect();
    }
  });

  test("concurrent pair flows stage into separate directories", async () => {
    // A shared staging directory let two in-flight pairings interleave their
    // Baileys credentials, and whichever finished first promoted the other's
    // half-written creds.json — a 440 on the next connect, escapable only by
    // wiping the directory by hand.
    const configDir = makeTempDir();

    const first = createPersistedPairingFactory(configDir, "5511888880000:0@s.whatsapp.net");
    const second = createPersistedPairingFactory(configDir, "5511999990000:0@s.whatsapp.net");

    const firstFlow = pairFlow(configDir, first.factory);
    const secondFlow = pairFlow(configDir, second.factory);
    await Promise.all([first.socketCreated, second.socketCreated]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Both are staged at once, each in its own directory.
    expect(stagingDirs(configDir)).toHaveLength(2);

    first.emitter.emit("connection.update", { connection: "open" });
    second.emitter.emit("connection.update", { connection: "open" });

    expect(await firstFlow).toBe(AccountId("+5511888880000"));
    expect(await secondFlow).toBe(AccountId("+5511999990000"));

    expect(stagingDirs(configDir)).toEqual([]);
    expect(existsSync(join(configDir, "whatsapp", "+5511888880000"))).toBe(true);
    expect(existsSync(join(configDir, "whatsapp", "+5511999990000"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 7: Multi-Account
// ---------------------------------------------------------------------------
describe("Multi-Account", () => {
  test("two providers operate independently", async () => {
    const p1 = await createConnectedProvider({
      accountId: "+111",
      meJid: "111:0@s.whatsapp.net",
    });
    const p2 = await createConnectedProvider({
      accountId: "+222",
      meJid: "222:0@s.whatsapp.net",
    });

    const ts = 1709900000;

    // Send messages to provider 1
    p1.emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [
          makeWAMessage({ id: "a1", remoteJid: CHAT_JID, text: "From P1", timestamp: ts }),
        ],
        isLatest: true,
      }),
    );

    // Send messages to provider 2
    p2.emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [
          makeWAMessage({ id: "b1", remoteJid: CHAT_JID, text: "From P2", timestamp: ts }),
        ],
        isLatest: true,
      }),
    );

    const r1 = await p1.source.sync(null);
    const r2 = await p2.source.sync(null);

    expect(r1.documents).toHaveLength(1);
    expect(r2.documents).toHaveLength(1);
    expect(r1.documents[0].content).toContain("From P1");
    expect(r1.documents[0].content).not.toContain("From P2");
    expect(r2.documents[0].content).toContain("From P2");
    expect(r2.documents[0].content).not.toContain("From P1");

    await p1.provider.disconnect();
    await p2.provider.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Group 8a: Group Roster Tracking
// ---------------------------------------------------------------------------
describe("Group Roster Tracking", () => {
  test("history sync triggers groupFetchAllParticipating and stores rosters", async () => {
    const { emitter, store, groupCalls } = await createConnectedProvider({
      groupRosters: {
        [GROUP_JID]: {
          participants: [
            { id: "111@s.whatsapp.net" },
            { id: "222@s.whatsapp.net" },
            { id: "333@s.whatsapp.net" },
          ],
        },
      },
    });

    emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [makeWAMessage({ id: "m1", remoteJid: GROUP_JID, timestamp: 1709900000 })],
        chats: [{ id: GROUP_JID, name: "Test Group" }],
        isLatest: true,
      }),
    );

    // refreshAllGroupRosters is fire-and-forget; let it run.
    await new Promise((r) => setTimeout(r, 10));

    expect(groupCalls.fetchAllCount).toBe(1);

    const chat = store.getChat(GROUP_JID);
    expect(chat?.participants).toEqual([
      "111@s.whatsapp.net",
      "222@s.whatsapp.net",
      "333@s.whatsapp.net",
    ]);
  });

  test("group-participants.update with action=add appends to roster", async () => {
    const { emitter, store } = await createConnectedProvider();

    // Seed an initial roster
    store.updateGroupRoster(GROUP_JID, ["111@s.whatsapp.net"]);

    emitter.emit("group-participants.update", {
      id: GROUP_JID,
      participants: ["222@s.whatsapp.net", "333@s.whatsapp.net"],
      action: "add",
    });

    expect(store.getChat(GROUP_JID)?.participants).toEqual([
      "111@s.whatsapp.net",
      "222@s.whatsapp.net",
      "333@s.whatsapp.net",
    ]);
  });

  test("group-participants.update with action=remove filters roster", async () => {
    const { emitter, store } = await createConnectedProvider();

    store.updateGroupRoster(GROUP_JID, [
      "111@s.whatsapp.net",
      "222@s.whatsapp.net",
      "333@s.whatsapp.net",
    ]);

    emitter.emit("group-participants.update", {
      id: GROUP_JID,
      participants: ["222@s.whatsapp.net"],
      action: "remove",
    });

    expect(store.getChat(GROUP_JID)?.participants).toEqual([
      "111@s.whatsapp.net",
      "333@s.whatsapp.net",
    ]);
  });

  test("group-participants.update with promote/demote does NOT change roster", async () => {
    const { emitter, store } = await createConnectedProvider();

    store.updateGroupRoster(GROUP_JID, ["111@s.whatsapp.net", "222@s.whatsapp.net"]);

    emitter.emit("group-participants.update", {
      id: GROUP_JID,
      participants: ["222@s.whatsapp.net"],
      action: "promote",
    });

    expect(store.getChat(GROUP_JID)?.participants).toEqual([
      "111@s.whatsapp.net",
      "222@s.whatsapp.net",
    ]);
  });

  test("groups.upsert triggers groupMetadata fetch", async () => {
    const { emitter, store, groupCalls } = await createConnectedProvider({
      groupMetadataByJid: {
        [GROUP_JID]: {
          participants: [{ id: "a@s.whatsapp.net" }, { id: "b@s.whatsapp.net" }],
        },
      },
    });

    emitter.emit("groups.upsert", [{ id: GROUP_JID, subject: "New Group" }]);

    // Let the async handler complete
    await new Promise((r) => setTimeout(r, 10));

    expect(groupCalls.metadataJids).toContain(GROUP_JID);
    expect(store.getChat(GROUP_JID)?.participants).toEqual([
      "a@s.whatsapp.net",
      "b@s.whatsapp.net",
    ]);
  });

  test("end-to-end: roster shows up in document people field", async () => {
    const { emitter, source, store } = await createConnectedProvider({
      accountId: "+5511999990000",
      groupRosters: {
        [GROUP_JID]: {
          participants: [
            { id: "5511999990000@s.whatsapp.net" }, // self
            { id: "447700000003@s.whatsapp.net" }, // Carla
            { id: "447700000004@s.whatsapp.net" }, // Anton
          ],
        },
      },
    });

    // Seed contacts so names resolve
    store.addContacts([
      { jid: "447700000003@s.whatsapp.net", name: "Carla" },
      { jid: "447700000004@s.whatsapp.net", name: "Anton" },
    ]);

    // Only "you" speaks today
    emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [
          makeWAMessage({
            id: "m1",
            remoteJid: GROUP_JID,
            participant: "5511999990000:0@s.whatsapp.net",
            fromMe: true,
            text: "Just me today",
            timestamp: 1709900000,
          }),
        ],
        chats: [{ id: GROUP_JID, name: "Family" }],
        isLatest: true,
      }),
    );

    // Wait for refreshAllGroupRosters to populate the roster
    await new Promise((r) => setTimeout(r, 20));

    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);

    const participants = result.documents[0].metadata.people!.filter(
      (p) => p.role === "participant",
    );
    const names = participants.map((p) => p.name).sort();
    expect(names).toEqual(["Anton", "Carla", "You"]);
  });

  test("seeds self LID→phone mapping from creds.me.lid on connect", async () => {
    const { store } = await createConnectedProvider({
      accountId: "+447700000000",
      meJid: "447700000000:6@s.whatsapp.net",
      meLid: "64171878182992:6@lid",
    });

    expect(store.lidPhoneMap.get("64171878182992")).toBe("+447700000000");
  });

  test("end-to-end: lid roster + self lid mapping → no duplicate self entry", async () => {
    const { emitter, source, store } = await createConnectedProvider({
      accountId: "+447700000000",
      meJid: "447700000000:6@s.whatsapp.net",
      meLid: "64171878182992:6@lid",
      groupRosters: {
        [GROUP_JID]: {
          participants: [
            { id: "64171878182992@lid" }, // self via LID
            { id: "109590956007500@lid" }, // Anton
          ],
        },
      },
    });

    // Add Anton's contact name
    store.addContacts([{ jid: "109590956007500@lid", name: "Anton" }]);

    // Self speaks once
    emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [
          makeWAMessage({
            id: "m1",
            remoteJid: GROUP_JID,
            participant: "447700000000:6@s.whatsapp.net",
            fromMe: true,
            text: "Hi",
            timestamp: 1709900000,
          }),
        ],
        chats: [{ id: GROUP_JID, name: "Tenancy" }],
        isLatest: true,
      }),
    );

    // Wait for refreshAllGroupRosters to populate
    await new Promise((r) => setTimeout(r, 20));

    const result = await source.sync(null);
    const participants = result.documents[0].metadata.people!.filter(
      (p) => p.role === "participant",
    );
    const names = participants.map((p) => p.name).sort();
    expect(names).toEqual(["Anton", "You"]);
  });

  test("ignores group-participants.update with empty participants array", async () => {
    const { emitter, store } = await createConnectedProvider();

    store.updateGroupRoster(GROUP_JID, ["111@s.whatsapp.net"]);

    emitter.emit("group-participants.update", {
      id: GROUP_JID,
      participants: [],
      action: "add",
    });

    expect(store.getChat(GROUP_JID)?.participants).toEqual(["111@s.whatsapp.net"]);
  });
});

// ---------------------------------------------------------------------------
// Group 7b: Identity capture — lid→phone + address-book names + business names
// ---------------------------------------------------------------------------
describe("Identity Capture", () => {
  // Invented fixtures only — fictional lid digits and +1 555 010 0xxx numbers.
  const LID_SENDER = "200000000000001@lid";
  const LID_BARE = "200000000000001";
  const LID_PHONE = "+12025550123";

  test("lid-mapping.update populates the lid→phone map", async () => {
    const { emitter, store } = await createConnectedProvider();

    emitter.emit("lid-mapping.update", {
      lid: LID_SENDER,
      pn: "12025550123:0@s.whatsapp.net",
    });

    expect(store.lidPhoneMap.get(LID_BARE)).toBe(LID_PHONE);
  });

  test("messaging-history.set lidPnMappings populate the lid→phone map", async () => {
    const { emitter, store } = await createConnectedProvider();

    emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        lidPnMappings: [{ lid: LID_SENDER, pn: "12025550123:0@s.whatsapp.net" }],
        isLatest: true,
      }),
    );

    expect(store.lidPhoneMap.get(LID_BARE)).toBe(LID_PHONE);
  });

  test("end-to-end: lid-only roster member gets its phone via bulk backfill", async () => {
    const { emitter, source, store } = await createConnectedProvider({
      accountId: "+12025559999",
      meJid: "12025559999:0@s.whatsapp.net",
      groupRosters: {
        [GROUP_JID]: {
          participants: [{ id: LID_SENDER }],
        },
      },
      // Persisted reverse store knows this lid's phone — but the contact
      // carries no phoneNumber, so deriveLidMapping can't surface it.
      lidPnReverseMap: { [LID_BARE]: "12025550123" },
    });

    store.addContacts([{ jid: LID_SENDER, name: "Maya Reeves" }]);

    emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [
          makeWAMessage({
            id: "m1",
            remoteJid: GROUP_JID,
            participant: "12025559999:0@s.whatsapp.net",
            fromMe: true,
            text: "Hi team",
            timestamp: 1709900000,
          }),
        ],
        chats: [{ id: GROUP_JID, name: "Project" }],
        isLatest: true,
      }),
    );

    // Allow refreshAllGroupRosters → backfillLidMappings to run.
    await new Promise((r) => setTimeout(r, 30));

    const result = await source.sync(null);
    const maya = result.documents[0].metadata.people!.find((p) => p.name === "Maya Reeves");
    expect(maya).toBeDefined();
    // The JID's local part is what the LID→phone map is keyed by; the alias
    // that leaves the provider carries the platform that issued it.
    expect(maya!.lids).toEqual([`whatsapp:${LID_BARE}`]);
    expect(maya!.phones).toEqual([LID_PHONE]);
  });

  test("contacts.update applies an address-book name over a bare pushName", async () => {
    const { emitter, store } = await createConnectedProvider();

    // First we only know the contact by their self-set pushName.
    emitter.emit("contacts.upsert", [{ id: LID_SENDER, notify: "Q" }]);
    expect(store.getContact(LID_SENDER)?.pushName).toBe("Q");
    expect(store.getContact(LID_SENDER)?.name).toBe("");

    // App-state resync delivers the saved address-book name.
    emitter.emit("contacts.update", [{ id: LID_SENDER, name: "Maya Reeves" }]);
    expect(store.getContact(LID_SENDER)?.name).toBe("Maya Reeves");
    // pushName is preserved, not clobbered.
    expect(store.getContact(LID_SENDER)?.pushName).toBe("Q");
  });

  test("contacts.update with an empty name does NOT clobber a stored name", async () => {
    const { emitter, store } = await createConnectedProvider();

    emitter.emit("contacts.update", [{ id: LID_SENDER, name: "Maya Reeves" }]);
    expect(store.getContact(LID_SENDER)?.name).toBe("Maya Reeves");

    // A later update carrying no name (e.g. only a status change) must keep it.
    emitter.emit("contacts.update", [{ id: LID_SENDER, notify: "Q" }]);
    expect(store.getContact(LID_SENDER)?.name).toBe("Maya Reeves");
  });

  test("contacts.update captures business verifiedName", async () => {
    const { emitter, store } = await createConnectedProvider();

    emitter.emit("contacts.update", [{ id: "biz@s.whatsapp.net", verifiedName: "Stellar Sound" }]);
    expect(store.getContact("biz@s.whatsapp.net")?.verifiedName).toBe("Stellar Sound");
  });

  test("resyncAppState is invoked on connection open with isInitialSync=false", async () => {
    const configDir = makeTempDir();
    const accountId = "+5511999990000";
    mkdirSync(join(configDir, "whatsapp", accountId, "auth"), { recursive: true });

    const { factory, emitter, resyncCalls } = createMockSocketFactory({ meJid: ME_JID });
    const provider = new WhatsAppProvider(accountId, configDir, factory);
    await provider.initialize();

    const authPromise = provider.authenticate();
    await new Promise((r) => setTimeout(r, 0));
    emitter.emit("connection.update", { connection: "open" });
    await authPromise;
    // Let the fire-and-forget resync run.
    await new Promise((r) => setTimeout(r, 0));

    expect(resyncCalls).toHaveLength(1);
    expect(resyncCalls[0].isInitialSync).toBe(false);
    // The full WAPatchName set, including the contact-name collections.
    expect(resyncCalls[0].collections).toContain("regular");
    expect(resyncCalls[0].collections).toContain("regular_high");

    await provider.disconnect();
  });

  test("group metadata subject becomes the group document title", async () => {
    const { emitter, source } = await createConnectedProvider({
      groupMetadataByJid: {
        [GROUP_JID]: { subject: "Weekend Hikers", participants: [{ id: CHAT_JID }] },
      },
    });

    // groups.upsert triggers fetchAndStoreGroupRoster → ingestGroupMetadata.
    emitter.emit("groups.upsert", [{ id: GROUP_JID }]);
    await new Promise((r) => setTimeout(r, 20));

    emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [
          makeWAMessage({
            id: "g1",
            remoteJid: GROUP_JID,
            participant: CHAT_JID,
            fromMe: false,
            text: "Anyone free Saturday?",
            timestamp: 1709900000,
          }),
        ],
        isLatest: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    const result = await source.sync(null);
    const doc = result.documents.find((d) => d.title.startsWith("Weekend Hikers"));
    expect(doc).toBeDefined();
    expect(doc!.title).toContain("Weekend Hikers");
  });
});

// ---------------------------------------------------------------------------
// Group 8: Data Cutoff
// ---------------------------------------------------------------------------
describe("Data Cutoff", () => {
  test("cutoff filters history messages end-to-end", async () => {
    // 2024-03-09T00:00:00Z = 1709942400
    const cutoff = "2024-03-09T00:00:00Z";
    const { emitter, source } = await createConnectedProvider({ dataCutoff: cutoff });

    emitter.emit(
      "messaging-history.set",
      makeHistorySyncEvent({
        messages: [
          makeWAMessage({ id: "old", remoteJid: CHAT_JID, text: "Old msg", timestamp: 1709900000 }), // 2024-03-08
          makeWAMessage({
            id: "new",
            remoteJid: CHAT_JID,
            text: "New msg",
            timestamp: 1709942400 + 3600,
          }), // 2024-03-09
        ],
        isLatest: true,
      }),
    );

    const result = await source.sync(null);
    // Should only have the 2024-03-09 document
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].externalId).toContain("2024-03-09");
    expect(result.documents[0].content).toContain("New msg");
    expect(result.documents[0].content).not.toContain("Old msg");
  });
});
