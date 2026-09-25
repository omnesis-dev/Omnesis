// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Source-management WS command handlers.
 *
 * These mirror what used to live on the collector's :7601 status server
 * (`/sources/*`). They run on the collector side, invoked by the gateway via
 * `wsClient.onCommand` whenever an admin client (CLI / portal / iOS) calls
 * the corresponding `/admin/sources/*` endpoint.
 *
 * Auth flows stream their NDJSON output from the auth subprocess back to the
 * gateway as `auth.update` / `auth.complete` events keyed by `flowId`. The
 * gateway forwards them to subscribers (SSE on the admin client side).
 */

import { hostname as osHostname } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import {
  KEYRING_ENV_KEYS,
  createLogger,
  toErrorMessage,
  hasProviderCredentials,
  writeProviderCredentials,
  clearProviderAccountCredentials,
  clearProviderCredentials,
  listProviderAccountIds,
  serializeCredentialsSpec,
  redactSecrets,
  validateCredentialFields,
  resolveSubprocessEntry,
} from "@omnesis/core";
import { serializeDescriptor } from "@omnesis/source-sdk";
import {
  parseAuthSubprocessEvent,
  type AuthSubprocessEvent,
  type AuthSubprocessInbound,
} from "./auth-subprocess-protocol.js";
import { createCommandDispatch } from "./ws-command-dispatch.js";
import type { AuthErrorCode, WsCommand, WsRequestPayload, WsResponsePayload } from "@omnesis/core";
import type { ConnectionState, GatewayClient } from "@omnesis/source-sdk";
import type { SourceManager } from "./source-manager.js";

/**
 * Largest unterminated stderr fragment held while waiting for a newline.
 * Redaction runs on assembled lines, so the buffer has to be bounded against a
 * child that never emits one.
 */
const MAX_UNTERMINATED_STDERR_BYTES = 1_000_000;

/**
 * How long a cancelled flow gets to end itself before it is signalled.
 *
 * Long enough for a provider's failure path to make one HTTP call — the shape
 * that needs it is revoking something the flow has just created upstream —
 * and short enough that a provider ignoring the message does not hold the
 * teardown open.
 */
const ABORT_GRACE_MS = 3_000;

/**
 * What the operator is told when a flow ends without connecting.
 *
 * It says which of the two happened. Someone who reached a consent screen and
 * refused is not the same event as a flow that was stopped, and reporting both
 * as a cancellation throws away the one sentence the platform's refusal came
 * with — the only thing on that path that tells the operator what they did.
 *
 * The detail is always a sentence the host mapped, never the platform's own
 * error string: this ends up on a record the admin listing returns.
 */
export function endedFlowOutcome(
  reason: "cancelled" | "denied" | undefined,
  detail: string | undefined,
): { ok: false; error: string; code: AuthErrorCode } {
  return reason === "denied"
    ? { ok: false, error: detail ?? "access was refused", code: "denied" }
    : { ok: false, error: detail ?? "cancelled", code: "user-cancelled" };
}

const log = createLogger("collector:source-ws");

export interface SourceWsHandlerDeps {
  sourceManager: SourceManager;
  gateway: GatewayClient;
  /** Push an event upstream to the gateway (e.g. `auth.update`). */
  emitEvent: (type: string, payload: unknown) => void;
  /**
   * Invoked after a command registers new source instances (`source.add`).
   * Wired to the same per-source metadata pushes (URL canonicalizers, score
   * priors, URL graph roles, self-identity hooks) the `sources.snapshot` handler
   * fires — without it a source added mid-session would not contribute its
   * canonicalizer until the next reconnect, so its URL flavours would not
   * dedup or resolve.
   */
  onSourcesChanged?: () => void;
}

export interface SourceWsHandlers {
  /**
   * Try to handle a command. Returns `undefined` if the command is not one of
   * the source.* / auth.* commands this module owns, so the caller can fall
   * through to other handlers. May return a value or a Promise.
   */
  handle: (command: WsCommand) => unknown | Promise<unknown> | undefined;
  /**
   * Tear down every still-active auth subprocess so the collector can
   * exit cleanly. Walks `activeFlows`, sends SIGTERM, awaits each
   * child's `exit` event with a 5s cap, then sends SIGKILL to anything
   * that didn't unwind in time. Wired from `main.ts:shutdown` before
   * `process.exit(0)` so a SIGINT during an in-flight OAuth dance
   * doesn't leak orphan `tsx` children that survive the parent.
   * Idempotent — safe to call from both the SIGINT and SIGTERM paths.
   */
  shutdown: () => Promise<void>;
}

export function createSourceWsHandlers(deps: SourceWsHandlerDeps): SourceWsHandlers {
  const { sourceManager, gateway, emitEvent } = deps;
  /** Active auth subprocesses, keyed by flowId, so we can cancel them. */
  const activeFlows = new Map<string, ChildProcess>();
  /**
   * Closes a flow's single-terminal-event latch from outside its reader.
   *
   * A cancel answers the operator at once and then gives the subprocess a few
   * seconds to end itself, which is time enough for it to finish what it was
   * doing and report success. Two terminal events for one flow is a flow that
   * reads as connected with nobody listening to register a source for it, so
   * the cancel closes the latch the reader owns rather than racing it.
   */
  const endFlow = new Map<string, () => void>();
  /** Active history imports, keyed by flowId; abort() terminates the worker. */
  const activeImports = new Map<string, AbortController>();

  // Typed dispatch table: a handler whose payload or answer disagrees with the
  // command's schema is a compile error, and the raw payload is parsed before
  // the handler sees it.
  const dispatch = createCommandDispatch();
  const register = dispatch.register.bind(dispatch);

  register("source.descriptors", () => handleDescriptors());
  register("source.validate-param", (p) => handleValidateParam(p));
  register("source.discover", (p) => handleDiscover(p));
  register("source.resolve-account", (p) => handleResolveAccount(p));
  register("sources.snapshot.request", () => handleSnapshot());
  register("source.add", (p) => handleAdd(p));
  register("source.reauth-finalize", (p) => handleReauthFinalize(p));
  register("auth.begin", (p) => handleAuthBegin(p));
  register("auth.cancel", (p) => handleAuthCancel(p));
  register("auth.code", (p) => handleAuthCode(p));
  register("auth.widget-result", (p) => handleAuthWidgetResult(p));
  register("auth.answer", (p) => handleAuthAnswer(p));
  register("import.begin", (p) => handleImportBegin(p));
  register("import.cancel", (p) => handleImportCancel(p));
  register("credentials.status", () => handleCredentialsStatus());
  register("credentials.set", (p) => handleCredentialsSet(p));
  register("credentials.clear", (p) => handleCredentialsClear(p));

  return {
    handle: (command) => dispatch.handle(command),
    shutdown: shutdownAllFlows,
  };

  /**
   * SIGTERM-then-SIGKILL teardown for all in-flight auth subprocesses.
   * Walks `activeFlows`, signals each via {@link terminateChild}, awaits
   * settle in parallel. The 5s SIGKILL fallback inside `terminateChild`
   * mirrors `gateway/src/triggers/exec-runner.ts:297-313` — same budget,
   * same behaviour.
   */
  async function shutdownAllFlows(): Promise<void> {
    // Abort any in-flight imports (terminates their workers) before exit.
    for (const ac of activeImports.values()) ac.abort();
    activeImports.clear();
    if (activeFlows.size === 0) return;
    const flowIds = [...activeFlows.keys()];
    log.info(
      `Shutdown: terminating ${flowIds.length} in-flight auth subprocess${flowIds.length === 1 ? "" : "es"}`,
    );
    const procs = flowIds.map((id) => activeFlows.get(id)).filter((p): p is ChildProcess => !!p);
    activeFlows.clear();
    await Promise.all(procs.map((p) => terminateChild(p)));
  }

  function terminateFlow(flowId: string): Promise<void> {
    const proc = activeFlows.get(flowId);
    activeFlows.delete(flowId);
    endFlow.delete(flowId);
    if (!proc) return Promise.resolve();
    return terminateChild(proc);
  }

  function handleDescriptors(): WsResponsePayload<"source.descriptors"> {
    // Push-based sources (the browser extension) are NOT filtered here: this
    // same feed populates the source-icon/metadata catalog the portal + iOS
    // read, so dropping them would strip their icon everywhere. Hiding push
    // sources from the "+ Add source" picker happens at the picker layer
    // instead (the serialized descriptor carries `pushBased`).
    //
    // `hostname` lets the CLI tell whether it's running on the same host as
    // the collector. Same host → safe to auto-open browser tabs (creds
    // wizard, OAuth callback) because the OAuth callback server will land
    // on this machine. Different host → render URLs only.
    return {
      // `gatewayHosted` sources (e.g. the unified Web Pages dataset) are owned
      // and advertised by the gateway itself — a collector never syncs them, so
      // it must not advertise them even though it still carries the provider
      // package in its registry. Otherwise the gateway's descriptor would
      // parasitically depend on a collector being online.
      descriptors: sourceManager
        .getDescriptors()
        .filter((d) => !d.gatewayHosted)
        .map(serializeDescriptor),
      hostname: osHostname(),
    };
  }

  function handleValidateParam(
    body: WsRequestPayload<"source.validate-param">,
  ): WsResponsePayload<"source.validate-param"> {
    const descriptor = sourceManager
      .getDescriptors()
      .find((d) => String(d.id) === body.descriptorId);
    if (!descriptor) throw new Error(`Unknown source: ${body.descriptorId}`);
    const param = descriptor.params?.find((p) => p.name === body.paramName);
    if (!param?.validate) return { valid: true };
    const error = param.validate(String(body.value ?? ""));
    return error ? { valid: false, error } : { valid: true };
  }

  async function handleDiscover(
    body: WsRequestPayload<"source.discover">,
  ): Promise<WsResponsePayload<"source.discover">> {
    const descriptor = sourceManager
      .getDescriptors()
      .find((d) => String(d.id) === body.descriptorId);
    if (!descriptor) throw new Error(`Unknown source: ${body.descriptorId}`);
    if (!descriptor.discover) {
      throw new Error(`Source ${body.descriptorId} does not support discovery`);
    }
    const accounts = await descriptor.discover({ configDir: sourceManager.getConfigDir() });
    // Ids only, for now: the wire shape a client renders is unchanged, and
    // what a descriptor adds reaches the gateway through the source row it is
    // stored on rather than through this listing.
    return { accounts: accounts.map((a) => String(a.id)) };
  }

  async function handleResolveAccount(
    body: WsRequestPayload<"source.resolve-account">,
  ): Promise<WsResponsePayload<"source.resolve-account">> {
    return { accountId: await sourceManager.resolveAccountId(body.descriptorId, body.params) };
  }

  function handleSnapshot(): WsResponsePayload<"sources.snapshot.request"> {
    const configured = sourceManager.getConfiguredSources();
    return { configured };
  }

  async function handleAdd(
    body: WsRequestPayload<"source.add">,
  ): Promise<WsResponsePayload<"source.add">> {
    const result = await sourceManager.addSources({
      descriptorId: body.descriptorId,
      accountIds: body.accountIds,
      params: body.params,
    });
    try {
      deps.onSourcesChanged?.();
    } catch (err) {
      // The add itself succeeded — a failed metadata push must not turn the
      // response into an error (the reconnect snapshot re-pushes anyway).
      log.warn(`onSourcesChanged failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return result;
  }

  /**
   * Re-instantiate every configured source under a `(providerType, accountId)`
   * after the OAuth subprocess has rotated tokens on disk. Driven by the
   * `cli reauth <provider-id>` verb. The actual auth flow runs through
   * `auth.begin` first; this is the second-step "now refresh the in-memory
   * source instances" call.
   */
  async function handleReauthFinalize(
    body: WsRequestPayload<"source.reauth-finalize">,
  ): Promise<WsResponsePayload<"source.reauth-finalize">> {
    return sourceManager.reauthProvider(body.providerType, body.accountId);
  }

  /**
   * Spawn the auth subprocess and stream its NDJSON events upstream as
   * `auth.update` / `auth.complete`. Returns immediately so the gateway can
   * wire up subscribers — the actual flow runs asynchronously.
   */
  function handleAuthBegin(body: WsRequestPayload<"auth.begin">): WsResponsePayload<"auth.begin"> {
    const descriptor = sourceManager.getDescriptors().find((d) => String(d.id) === body.sourceType);
    if (!descriptor) throw new Error(`Unknown source: ${body.sourceType}`);
    if (!descriptor.authFlow && !descriptor.authenticate) {
      throw new Error(`Source ${body.sourceType} does not support auth flow`);
    }

    const flowId = body.flowId;
    // Source mode spawns `npx tsx <auth-subprocess.ts>` (tsx walks up from
    // cwd looking for node_modules/tsx — anchoring cwd to the handler's dir
    // keeps the resolver inside this package); compiled mode spawns node on
    // the emitted dist sibling directly.
    const entry = resolveSubprocessEntry("./auth-subprocess.ts", import.meta.url);
    const args = [...entry.args, body.sourceType];
    if (body.params) args.push(JSON.stringify(body.params));

    //
    // Pass an explicit minimal env instead of inheriting
    // process.env. The subprocess only needs PATH (find npx/node),
    // HOME (token-cache lookups), LANG (locale-sensitive parsers),
    // D-Bus session handles for OS keyring access on Linux, whatever the
    // secret store declares it reads (`KEYRING_ENV_KEYS` — without those the
    // child selects a backend it cannot open, so no keyring-encrypted store
    // opens), and Omnesis's own configuration knobs. Anything else — random
    // shell exports, unrelated cloud-credential env vars, debug
    // tokens — could otherwise leak into a third-party OAuth client
    // library. Mirrors the exec-runner.ts approach (#triggers/exec).
    const env: Record<string, string> = {};
    for (const key of [
      "PATH",
      "HOME",
      "LANG",
      "LC_ALL",
      "TZ",
      "TMPDIR",
      "USER",
      "LOGNAME",
      "DBUS_SESSION_BUS_ADDRESS",
      "XDG_RUNTIME_DIR",
      ...KEYRING_ENV_KEYS,
    ]) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    // Forward the OMNESIS_* keys the auth subprocess actually
    // consumes (config dir, gateway URL for callback delivery,
    // credentials path overrides). Subprocess `process.env` reads
    // beyond this set should fail loudly so we don't accidentally
    // open new env-deps without auditing them.
    for (const [key, value] of Object.entries(process.env)) {
      if (!value) continue;
      if (!key.startsWith("OMNESIS_")) continue;
      // Withheld deliberately: the child's logger writes directly to this file
      // when it is set, which would put provider log lines into the collector's
      // log without passing the stderr redaction below. Unset, they arrive on
      // stderr and are redacted.
      if (key === "OMNESIS_LOG_FILE") continue;
      env[key] = value;
    }
    env.OMNESIS_CONFIG_DIR = sourceManager.getConfigDir();

    // Validate the pasted fields here rather than in the provider: this is the
    // only place that still holds the spec, and it is the last point at which a
    // rejection is a clean error instead of a half-run flow. Undeclared keys are
    // dropped, so nothing outside the spec ever reaches the subprocess.
    //
    // Only a NEW add must carry them. A re-auth names the account it is
    // refreshing and may legitimately send none, in which case the provider
    // re-reads that account's stored credential — requiring them here would
    // make re-authentication impossible for every per-account provider.
    let cleanedCredentials: Record<string, string> | undefined;
    if (descriptor.credentials?.perAccount && (body.credentials || !body.accountId)) {
      const validated = validateCredentialFields(body.credentials ?? {}, descriptor.credentials);
      if (!validated.ok) throw new Error(validated.error);
      cleanedCredentials = validated.cleaned;
    }
    // Values to strip from anything this flow reports back. `GET
    // /admin/auth-flows` hands every flow to every admin caller, and the
    // stderr tail is interpolated into a log line on any non-terminal end, so
    // a provider that echoes its input must not be able to leak it there.
    // Known bug: #97 — masks every credential field, not only the ones the spec marks secret.
    const secretValues = Object.values(cleanedCredentials ?? {}).filter((v) => v.length > 0);

    const proc = spawn(entry.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: import.meta.dirname,
      env,
    });
    activeFlows.set(flowId, proc);
    log.info(`auth.begin spawned subprocess for flow=${flowId} source=${body.sourceType}`);

    // stdin is the inbound NDJSON channel to the subprocess (init + code
    // delivery — see `AuthSubprocessInbound`). Swallow EPIPE-style errors:
    // a child that dies mid-flow closes its end and the regular
    // exit/terminal-event paths already report the failure.
    proc.stdin?.on("error", (err) => {
      log.debug(`auth subprocess stdin error (${flowId}): ${toErrorMessage(err)}`);
    });
    // Tell the subprocess its gateway flow id right away so the provider
    // can embed it as `state=` in its authorize URL. On re-auth flows the
    // gateway also passes the accountId being re-authenticated, surfaced
    // to the provider as `callbacks.accountId`. The gateway's
    // externally-reachable HTTPS base URL (when configured) rides along too,
    // surfaced as `callbacks.publicBaseUrl` so OAuth/aggregator providers
    // build `${publicBaseUrl}/oauth/callback` instead of a localhost
    // callback. Empty strings are normalised away so the strict init schema
    // never drops the whole line.
    writeInbound(proc, {
      type: "init",
      flowId,
      accountId: body.accountId || undefined,
      credentials: cleanedCredentials,
      publicBaseUrl: body.publicBaseUrl || undefined,
      renders: body.renders,
    });

    // Drain stderr so the OS pipe buffer (~64KB) can't fill and
    // deadlock the child. Baileys pairing logs and tsx loader warnings
    // are verbose; without an active reader the subprocess blocks on
    // its next stderr write while we're awaiting stdout, the auth flow
    // hangs forever, and the user sees no progress. Lines are kept in a
    // small sliding window so the "no terminal event" diagnostic below
    // has something to surface — debug log otherwise.
    const stderr = proc.stderr;
    const stderrTail: string[] = [];
    if (stderr) {
      stderr.setEncoding("utf8");
      // Assembled across chunks before redacting: stream boundaries fall
      // wherever the OS puts them, and a secret split across two chunks would
      // survive substring matching on each half.
      let stderrBuffer = "";
      stderr.on("data", (chunk: string) => {
        stderrBuffer += chunk;
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() ?? "";
        // A pathological producer that never emits a newline would otherwise
        // grow this without bound.
        if (stderrBuffer.length > MAX_UNTERMINATED_STDERR_BYTES) stderrBuffer = "";
        if (lines.length === 0) return;
        const trimmed = redactSecrets(lines.join("\n"), secretValues);
        log.debug(`auth subprocess stderr (${flowId}): ${trimmed}`);
        for (const line of trimmed.split("\n")) {
          stderrTail.push(line);
          if (stderrTail.length > 20) stderrTail.shift();
        }
      });
    }

    // Exit code / signal is the cheapest signal for "why did the
    // subprocess die" when an auth flow fails. One line per pair attempt.
    proc.on("exit", (code, signal) => {
      log.info(`auth subprocess (${flowId}) exited: code=${code} signal=${signal ?? "none"}`);
    });
    // Without a listener, a failed spawn (ENOENT / EACCES / EAGAIN) emits
    // `error` with nothing attached and Node rethrows it — taking the whole
    // collector down in the middle of an auth flow.
    proc.on("error", (err) => {
      log.error(`auth subprocess (${flowId}) failed to start: ${toErrorMessage(err)}`);
    });

    void runFlowSubprocess(flowId, body.sourceType, proc, stderrTail, secretValues).finally(() => {
      activeFlows.delete(flowId);
      endFlow.delete(flowId);
    });

    return { started: true };
  }

  async function runFlowSubprocess(
    flowId: string,
    sourceType: string,
    proc: ChildProcess,
    stderrTail: string[] = [],
    /** Pasted values to strip from any diagnostic this flow emits. */
    secretValues: readonly string[] = [],
  ): Promise<void> {
    const stdout = proc.stdout;
    if (!stdout) throw new Error("auth subprocess has no stdout");
    stdout.setEncoding("utf8");
    let buffer = "";
    let resolvedAccountIds: string[] | undefined;
    let resolvedAccountStates: Record<string, ConnectionState> | undefined;
    let resolvedNotices: Array<{ title: string; detail?: string }> | undefined;
    // `terminalEmitted` is the single-terminal-event invariant: at most
    // one `auth.complete` (success or error) per process. After it flips
    // we still drain stdout to EOF (so the child sees its writes
    // accepted and exits cleanly) but ignore further events.
    let terminalEmitted = false;
    endFlow.set(flowId, () => {
      terminalEmitted = true;
    });
    // Inactivity watchdog: if the subprocess goes silent for this long
    // mid-flow, kill it and surface a `code: "timeout"` error. 30 minutes
    // is generous for an interactive OAuth dance (the longest realistic
    // step is the user reading the consent screen + entering 2FA) but
    // strict enough that a hung subprocess can't pin a flowId
    // indefinitely after the user has wandered away.
    const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
    let inactivityTimer: NodeJS.Timeout | null = null;
    const armWatchdog = (): void => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        if (terminalEmitted) return;
        terminalEmitted = true;
        log.warn(
          `auth subprocess inactive for ${INACTIVITY_TIMEOUT_MS / 60000}m, killing flow=${flowId}`,
        );
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        emitEvent("auth.complete", {
          flowId,
          ok: false,
          error: "auth subprocess inactive — flow timed out",
          code: "timeout" satisfies AuthErrorCode,
        });
      }, INACTIVITY_TIMEOUT_MS);
    };

    // Counters used in the "no terminal event" diagnostic so we know how
    // far the subprocess got before going dark.
    let lineCount = 0;
    const eventTypesSeen: string[] = [];
    const handleLine = (line: string): void => {
      if (!line) return;
      lineCount++;
      // Reset the watchdog on every well-formed AND malformed line —
      // any byte from the subprocess is proof of life.
      armWatchdog();
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      // Per-variant validation: a malformed `{type:"url"}` (missing url)
      // would previously have been forwarded to the gateway as `{flowId,
      // type:"url"}`, breaking the portal's "open this URL" affordance.
      // Drop malformed events with a debug log instead.
      const event: AuthSubprocessEvent | null = parseAuthSubprocessEvent(parsed);
      if (!event) {
        log.debug(
          `Dropping malformed auth-subprocess event for ${flowId}: ` +
            redactSecrets(line.slice(0, 120), secretValues),
        );
        return;
      }
      eventTypesSeen.push(event.type);
      // Drop any event after a terminal one. The protocol contract is
      // exactly-once `complete` or `error`; a buggy subprocess emitting
      // a follow-up `url` (or a second `error`) would otherwise leak to
      // the gateway after the consumer already declared the flow done.
      if (terminalEmitted) {
        log.debug(`Dropping post-terminal auth-subprocess event for ${flowId}: ${event.type}`);
        return;
      }
      if (event.type === "complete") {
        resolvedAccountIds = event.accountIds;
        resolvedAccountStates = event.accountStates;
        resolvedNotices = event.notices;
        // Don't emit completion until cursor reset (below) is done.
        // The terminal flag flips at emit time after the await loop, so
        // a malformed second `complete` mid-stream is still ignored
        // because `terminalEmitted` flips here.
        terminalEmitted = true;
        return;
      }
      if (event.type === "error") {
        terminalEmitted = true;
        emitEvent("auth.complete", {
          flowId,
          ok: false,
          error: event.error ?? "unknown auth error",
          code: event.code,
          fileKey: event.fileKey,
          providerName: event.providerName,
          remedy: event.remedy,
          retryAfterMs: event.retryAfterMs,
        });
        return;
      }
      // url / qr / widget / challenge / progress — forward as auth.update (the
      // gateway fans it out to SSE subscribers). The event passes through
      // whole: a `challenge` carries its own kind and its own words, so
      // nothing in between has to know which provider produced it.
      emitEvent("auth.update", { flowId, ...event });
    };

    armWatchdog();
    try {
      // Drain stdout to EOF. Even after a terminal event the loop keeps
      // reading so the child's pipe writes don't block — letting the
      // child exit cleanly instead of stalling on a full pipe buffer.
      for await (const chunk of stdout) {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          handleLine(buffer.slice(0, idx).trim());
          buffer = buffer.slice(idx + 1);
        }
      }
      if (buffer.trim()) handleLine(buffer.trim());
    } catch (err) {
      log.warn(`auth subprocess stream failed for ${flowId}: ${toErrorMessage(err)}`);
    } finally {
      if (inactivityTimer) clearTimeout(inactivityTimer);
    }

    if (resolvedAccountIds) {
      // Don't reset the cursor on auth-completion. The previous behaviour
      // wiped sync_state every time `cli add <source>` finished its OAuth
      // dance — including the common "credential refresh" case where the
      // user re-authed the *same* accountId because tokens expired. That
      // forced a 30–60-min re-bootstrap on Outlook / Gmail / Drive every
      // time the user fixed a transient auth error. A true re-pair with
      // a different accountId lands on a different sourceId and starts
      // with no cursor anyway, so there's nothing to reset there either.
      // Users who actually want a clean re-bootstrap should use
      // `cli remove <source>` followed by `cli add <source>`.
      //
      // `accountId` carries the first id for back-compat with single-account
      // consumers; `accountIds` carries the full set so a one-session →
      // many-institutions hosted-widget flow registers every selected account.
      emitEvent("auth.complete", {
        flowId,
        ok: true,
        accountId: resolvedAccountIds[0],
        accountIds: resolvedAccountIds,
        accountStates: resolvedAccountStates,
        notices: resolvedNotices,
      });
    } else if (!terminalEmitted) {
      // Subprocess closed stdout without ever sending a terminal event —
      // crash, kill, or a producer bug. Surface as `unknown` so the UI
      // can render a generic "auth flow ended unexpectedly" without
      // pretending we know why.
      log.warn(
        `auth subprocess (${flowId}) ended without terminal event: ` +
          `lines=${lineCount} events=[${eventTypesSeen.join(",")}] ` +
          `bufferAtEof=${JSON.stringify(redactSecrets(buffer.slice(0, 160), secretValues))} ` +
          `stderrTail=${JSON.stringify(stderrTail.slice(-10))}`,
      );
      emitEvent("auth.complete", {
        flowId,
        ok: false,
        error: "auth subprocess exited without a complete event",
        code: "unknown" satisfies AuthErrorCode,
      });
    }
  }

  /** Write one NDJSON line to the auth subprocess's stdin channel. */
  function writeInbound(proc: ChildProcess, message: AuthSubprocessInbound): boolean {
    const stdin = proc.stdin;
    if (!stdin || !stdin.writable) return false;
    stdin.write(JSON.stringify(message) + "\n");
    return true;
  }

  // Code-delivery channel only: forwards a gateway-routed authorization code to the live auth subprocess over stdin; NOT the buildAuthUrl/exchangeCode split (that remains future work for iOS).
  function handleAuthCode(body: WsRequestPayload<"auth.code">): WsResponsePayload<"auth.code"> {
    const proc = activeFlows.get(body.flowId);
    if (!proc) {
      throw new Error(`auth.code for unknown or already-finished flow: ${body.flowId}`);
    }
    if (
      proc.exitCode !== null ||
      proc.signalCode !== null ||
      !writeInbound(proc, { type: "code", code: body.code })
    ) {
      throw new Error(`auth.code for exited flow: ${body.flowId}`);
    }
    log.info(
      `auth.code forwarded to subprocess for flow=${body.flowId} codeLen=${body.code.length}`,
    );
    return { ok: true };
  }

  // Hosted-widget (`link-widget`) result-delivery channel — symmetric to
  // `auth.code` but carries the opaque widget result token (e.g. a Plaid
  // `public_token`) + optional metadata back to the live subprocess over
  // stdin, resolving the provider's pending `receiveWidgetResult()`. A
  // widget that yields several results forwards each one.
  function handleAuthWidgetResult(
    body: WsRequestPayload<"auth.widget-result">,
  ): WsResponsePayload<"auth.widget-result"> {
    const proc = activeFlows.get(body.flowId);
    if (!proc) {
      throw new Error(`auth.widget-result for unknown or already-finished flow: ${body.flowId}`);
    }
    if (
      proc.exitCode !== null ||
      proc.signalCode !== null ||
      !writeInbound(proc, { type: "widget-result", token: body.token, metadata: body.metadata })
    ) {
      throw new Error(`auth.widget-result for exited flow: ${body.flowId}`);
    }
    log.info(`auth.widget-result forwarded to subprocess for flow=${body.flowId}`);
    return { ok: true };
  }

  function handleAuthAnswer(
    body: WsRequestPayload<"auth.answer">,
  ): WsResponsePayload<"auth.answer"> {
    const proc = activeFlows.get(body.flowId);
    if (!proc) {
      throw new Error(`auth.answer for unknown or already-finished flow: ${body.flowId}`);
    }
    if (
      proc.exitCode !== null ||
      proc.signalCode !== null ||
      !writeInbound(proc, { type: "answer", id: body.challengeId, answer: body.answer })
    ) {
      throw new Error(`auth.answer for exited flow: ${body.flowId}`);
    }
    // The answer's contents are the operator's, and may be a secret; only the
    // fact that one arrived is logged.
    log.info(
      `auth.answer forwarded to subprocess for flow=${body.flowId} challenge=${body.challengeId}`,
    );
    return { ok: true };
  }

  function handleAuthCancel(
    body: WsRequestPayload<"auth.cancel">,
  ): WsResponsePayload<"auth.cancel"> {
    const proc = activeFlows.get(body.flowId);
    if (proc) {
      // Tell it before killing it. A provider waiting on an answer sees a typed
      // failure and its own catch runs — which is the only chance a provider
      // that has just created something at a third party gets to undo it. The
      // teardown still happens; it is delayed by a grace period so that path
      // has time, and a provider that ignores the message loses only that.
      writeInbound(proc, {
        type: "abort",
        reason: body.reason ?? "cancelled",
        detail: body.detail,
      });
      setTimeout(() => void terminateFlow(body.flowId), ABORT_GRACE_MS).unref();
      // Close the reader's latch first: what follows is this flow's one
      // terminal event, and the subprocess has a few seconds left in which it
      // could otherwise report a second.
      endFlow.get(body.flowId)?.();
      emitEvent("auth.complete", {
        flowId: body.flowId,
        ...endedFlowOutcome(body.reason, body.detail),
      });
      log.info(`auth.cancel signalled subprocess for flow=${body.flowId}`);
    }
    return { ok: true };
  }

  // ── History import — run source.importHistory() ──
  // The source decrypts/parses in a worker thread but merges into its own store
  // from THIS process (single writer). Cancellation aborts the worker. This is
  // the sole emitter of import.complete (the gateway cancel route only mutates
  // the flow record, no fan-out), so a cancel never double-completes.
  function handleImportBegin(
    body: WsRequestPayload<"import.begin">,
  ): WsResponsePayload<"import.begin"> {
    const { flowId, sourceId, values } = body;
    const ac = new AbortController();
    activeImports.set(flowId, ac);
    void (async () => {
      try {
        const summary = await sourceManager.importHistory(sourceId, values, {
          signal: ac.signal,
          onProgress: (p) => {
            if (ac.signal.aborted) return;
            emitEvent("import.progress", {
              flowId,
              phase: p.phase,
              processed: p.processed,
              total: p.total,
              detail: p.detail,
            });
          },
        });
        if (!ac.signal.aborted) {
          emitEvent("import.complete", {
            flowId,
            ok: true,
            imported: summary.imported,
            merged: summary.merged,
            skipped: summary.skipped,
          });
        }
      } catch (err) {
        emitEvent("import.complete", {
          flowId,
          ok: false,
          error: ac.signal.aborted ? "cancelled" : err instanceof Error ? err.message : String(err),
        });
      } finally {
        activeImports.delete(flowId);
      }
    })();
    log.info(`import.begin running for flow=${flowId} source=${sourceId}`);
    return { started: true };
  }

  function handleImportCancel(
    body: WsRequestPayload<"import.cancel">,
  ): WsResponsePayload<"import.cancel"> {
    const ac = activeImports.get(body.flowId);
    if (ac) {
      // Aborts the worker; the import promise rejects and the begin handler
      // above emits the single import.complete{ok:false,error:"cancelled"}.
      ac.abort();
      log.info(`import.cancel signalled for flow=${body.flowId}`);
    }
    return { ok: true };
  }

  // ── Credentials management ────────────────────────────────────────────

  /**
   * Distinct provider credential specs, keyed by `fileKey`. The same spec
   * shows up on every source under the provider; collapse to one entry per
   * provider for the credentials view.
   */
  function listCredentialEntries(): Array<{
    fileKey: string;
    providerType: string;
    providerName: string;
    spec: ReturnType<typeof serializeCredentialsSpec>;
    configured: boolean;
  }> {
    const seen = new Map<
      string,
      {
        providerType: string;
        providerName: string;
        spec: ReturnType<typeof serializeCredentialsSpec>;
      }
    >();
    for (const d of sourceManager.getDescriptors()) {
      if (!d.credentials) continue;
      if (seen.has(d.credentials.fileKey)) continue;
      seen.set(d.credentials.fileKey, {
        providerType: String(d.provider.id),
        providerName: d.provider.name,
        spec: serializeCredentialsSpec(d.credentials),
      });
    }
    const configDir = sourceManager.getConfigDir();
    return [...seen.entries()].map(([fileKey, v]) => ({
      fileKey,
      ...v,
      // For a per-account provider there is no provider-wide file to look for
      // once accounts have their own, so "configured" means at least one
      // account holds a credential — or a not-yet-adopted shared file does.
      configured: v.spec.perAccount
        ? listProviderAccountIds(fileKey, configDir).length > 0 ||
          hasProviderCredentials(fileKey, configDir)
        : hasProviderCredentials(fileKey, configDir),
    }));
  }

  function handleCredentialsStatus(): WsResponsePayload<"credentials.status"> {
    return { hostname: osHostname(), entries: listCredentialEntries() };
  }

  async function handleCredentialsSet(
    body: WsRequestPayload<"credentials.set">,
  ): Promise<WsResponsePayload<"credentials.set">> {
    // Validate against the matching provider's spec — refuse fileKeys we
    // don't recognise so a typo can't leave a stray creds file behind, and
    // refuse fields with the wrong shape.
    const entry = listCredentialEntries().find((e) => e.fileKey === body.fileKey);
    if (!entry) throw new Error(`Unknown credentials fileKey: ${body.fileKey}`);
    // A per-account credential has no provider-wide slot to write into, and
    // writing one anyway would be ignored: once an account has its own file,
    // that is what the source reads. Name the commands that do work.
    if (entry.spec.perAccount) {
      throw new Error(
        `${body.fileKey} credentials belong to a single account. ` +
          `Run \`omnesis sources add <type>\` to connect an account, or ` +
          `\`omnesis sources reauth <source-id>\` to replace a rotated key.`,
      );
    }
    const result = validateCredentialFields(body.fields, entry.spec);
    if (!result.ok) throw new Error(result.error);
    await writeProviderCredentials(body.fileKey, result.cleaned, sourceManager.getConfigDir());
    log.info(`Credentials written for ${body.fileKey}`);
    return { ok: true, fileKey: body.fileKey };
  }

  async function handleCredentialsClear(
    body: WsRequestPayload<"credentials.clear">,
  ): Promise<WsResponsePayload<"credentials.clear">> {
    const entry = listCredentialEntries().find((e) => e.fileKey === body.fileKey);
    if (!entry) throw new Error(`Unknown credentials fileKey: ${body.fileKey}`);
    const configDir = sourceManager.getConfigDir();
    // For a per-account provider the shared file is at most a not-yet-adopted
    // leftover: the live credentials are the per-account ones. Clearing only
    // the shared file would report success while every source kept syncing —
    // a revocation that does not revoke.
    if (entry.spec.perAccount) {
      const accounts = listProviderAccountIds(body.fileKey, configDir);
      for (const accountId of accounts) {
        await clearProviderAccountCredentials(body.fileKey, accountId, configDir);
      }
      log.info(
        `Credentials cleared for ${body.fileKey}: ${accounts.length} account(s) [${accounts.join(", ")}]`,
      );
    }
    await clearProviderCredentials(body.fileKey, configDir);
    log.info(`Credentials cleared for ${body.fileKey}`);
    return { ok: true, fileKey: body.fileKey };
  }
}

/**
 * Standalone SIGTERM-then-SIGKILL helper. Exposed at module scope so
 * tests can verify the dual-signal escalation against a real spawned
 * child without having to drive the whole `auth.begin` flow.
 *
 * Returns a promise that resolves on `exit` (or `error`). On a child
 * that's already exited, resolves synchronously. Failures inside
 * `kill()` are best-effort and swallowed — the caller's only signal
 * is "settled" vs "still pending past the 5s SIGKILL fallback".
 */
export function terminateChild(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve();
    };
    proc.once("exit", finish);
    proc.once("error", finish);
    try {
      proc.kill("SIGTERM");
    } catch {
      /* best-effort */
    }
    const killTimer = setTimeout(() => {
      try {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGKILL");
        }
      } catch {
        /* best-effort */
      }
    }, 5_000);
    killTimer.unref();
  });
}
