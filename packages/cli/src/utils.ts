// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createInterface } from "node:readline";
import { readdirSync, statSync } from "node:fs";
import {
  dirname,
  basename as pathBasename,
  join as pathJoin,
  resolve as pathResolve,
} from "node:path";
import {
  c as cShared,
  disabledColors,
  buildCliFx as buildCliFxShared,
  makeSourceMetaCache,
  withSpinner as withSpinnerShared,
  CliError,
  EXIT_AUTH,
  EXIT_CANCELLED,
  EXIT_FAILURE,
  EXIT_GATEWAY_ERROR,
  EXIT_USER_ERROR,
} from "@omnesis/cli-shared";
import {
  DEFAULT_CONFIG_DIR,
  localGatewayRequestUrl,
  resolveSourcePatterns,
  resolveToken,
} from "@omnesis/core";
import { sourceTypeOf } from "@omnesis/types";
import type { CliFx, SourceMeta, SpinnerHandle } from "@omnesis/cli-shared";

export {
  formatSize,
  formatDateShort,
  formatInterval,
  formatTimeAgo,
  formatTimeAgoMs,
  iconFor,
  linkify,
  CliError,
  EXIT_AUTH,
  EXIT_CANCELLED,
  EXIT_FAILURE,
  EXIT_GATEWAY_DOWN,
  EXIT_GATEWAY_ERROR,
  EXIT_OK,
  EXIT_PARTIAL,
  EXIT_USER_ERROR,
  cliConstants,
} from "@omnesis/cli-shared";
export type { CliFx, SourceMeta, SpinnerHandle } from "@omnesis/cli-shared";

// Bare argv (post `--` strip), retained for the few callsites that still
// need the raw slice — JSON-mode detection and the few legacy locations
// that haven't been migrated to citty's parsed `args` object yet.
//
// Strip bare "--" tokens (getopt's end-of-options marker). npm's
// `npm run foo -- bar` syntax already consumes one `--`, but users
// sometimes land on `npm run cli -- status -- watch` (common when
// copy/pasting example commands) which arrives as
// `["status", "--", "watch"]` — making `args.includes("--watch")` false
// and silently dropping flags.
const rawArgv = process.argv.slice(2).filter((a) => a !== "--");

export const GATEWAY_URL = process.env.OMNESIS_GATEWAY_URL ?? "https://localhost:7600";

/**
 * Where this CLI sends its requests. `GATEWAY_URL` is the address the install
 * recorded — also the one printed for other machines — and on the gateway's
 * own machine it may name a host that does not resolve here (`omnesis.local`
 * on a Linux server, or on macOS where node is denied local network access).
 * When a live gateway on this host holds the config directory, requests go
 * over loopback on the same port instead.
 */
export const GATEWAY_REQUEST_URL = localGatewayRequestUrl(
  GATEWAY_URL,
  process.env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
);

/**
 * Whether a gateway URL names this machine. Only then do local files — the
 * gateway lock, `omnesis.json` — describe the gateway that URL reaches.
 */
export function targetsLocalGateway(url: string = GATEWAY_REQUEST_URL): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * Build the URL a result title should hyperlink to on OSC 8-capable terminals.
 *Precedence:
 *   1. The `OMNESIS_RESULT_URI` template, if set — a power-user override to
 *      route results into an editor/app. Placeholders: `{id}` (document id),
 *      `{sourceUrl}` (the result's own URL, empty when it has none), and
 *      `{portal}` (the gateway portal page for the document). e.g.
 *      `obsidian://open?path={sourceUrl}` or `file://{sourceUrl}`.
 *   2. The result's own `sourceUrl` (the Gmail thread, the file, …).
 *   3. The gateway portal document page — the universal fallback that always
 *      resolves, even for sources with no openable native URL.
 */
export function buildResultUrl(documentId: string, sourceUrl?: string | null): string {
  const portal = `${GATEWAY_URL}/portal/doc/${documentId}`;
  const template = process.env.OMNESIS_RESULT_URI;
  if (template) {
    return template
      .replaceAll("{id}", documentId)
      .replaceAll("{sourceUrl}", sourceUrl ?? "")
      .replaceAll("{portal}", portal);
  }
  return sourceUrl || portal;
}

// Output mode — `--json` or piped stdout switches the read-side commands
// (search/show/recent/sql/whoami/health/...) to machine-readable output and
// disables ANSI color + spinners. Admin commands (add/sync/etc.) ignore this
// flag — they're interactive only.
export const isJSON = rawArgv.includes("--json") || !process.stdout.isTTY;

// Color palette, swapped to no-op codes whenever JSON mode is active so
// piped output never carries terminal control bytes. Same trick query-cli
// used; the cast lets callers index `c.red` etc. without TS complaining
// about the union with `disabledColors()` return type.
export const c = (isJSON ? disabledColors() : cShared) as Record<string, string>;

import type { SerializedDescriptor } from "@omnesis/source-sdk";

export type { SerializedDescriptor } from "@omnesis/source-sdk";

/**
 * Make an authenticated request to the gateway, picking the bearer token
 * from OMNESIS_TOKEN or ~/.config/omnesis/token.
 */
export async function gatewayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = resolveToken();
  if (!token) {
    throw new CliError(
      "No auth token found. Start the gateway first (auto-generates one) or set OMNESIS_TOKEN.",
      EXIT_AUTH,
    );
  }
  const url = path.startsWith("http") ? path : `${GATEWAY_REQUEST_URL}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "omnesis",
      ...(init.headers ?? {}),
    },
  });
}

export async function gatewayJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await gatewayFetch(path, init);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const code = pickGatewayExitCode(res.status);
    throw new CliError(`Gateway ${res.status} ${path}: ${txt}`, code);
  }
  return res.json() as Promise<T>;
}

/** Map an HTTP status to one of the well-known CLI exit codes. */
export function pickGatewayExitCode(status: number): number {
  if (status === 401 || status === 403) return EXIT_AUTH;
  if (status >= 500) return EXIT_GATEWAY_ERROR;
  if (status >= 400) return EXIT_USER_ERROR;
  return EXIT_FAILURE;
}

/** Shorter alias used by the read-side commands (search/show/...). */
export const gw = gatewayFetch;

/**
 * Fail with a message + exit code. Honors `isJSON` so machine-readable
 * consumers always get a JSON error envelope instead of an ANSI string.
 *
 * Implementation note: `die` throws `CliError` rather than calling
 * `process.exit` so spinner cleanup runs. The top-level `runCli` wrapper
 * catches and exits — see `cli-shared/runner.ts`. The `code` parameter
 * defaults to `EXIT_FAILURE`; pass an `EXIT_*` constant for typed exit
 * codes (`EXIT_USER_ERROR`, `EXIT_GATEWAY_DOWN`, etc.).
 */
export function die(msg: string, code = EXIT_FAILURE): never {
  if (isJSON) {
    console.log(JSON.stringify({ error: msg }));
    throw new CliError("", code);
  }
  throw new CliError(`${c.red}${msg}${c.reset}`, code);
}

// ── Terminal-UX helpers (icons + hyperlinks) ──────────────────────────
// The CLI pulls per-source icons from the gateway's existing
// `/portal/source-meta.json` endpoint — same source of truth the portal
// uses. Detection + rendering primitives live in
// `@omnesis/core/terminal-fx`; this file wires them into a single
// `CliFx` context that commands pass through their render functions.
//
// Shipped surface is iTerm2-only (see terminal-fx/index.ts). On any
// other terminal the helpers degrade to empty icons + plain URLs.

/**
 * Process-lifetime cache for `/portal/source-meta.json`. Owned here so
 * tests can `clearSourceMetaCache()` between runs (the cli-shared module
 * deliberately stopped exposing a singleton). For the CLI binary this
 * is effectively still "fetch once and reuse forever" — the cache's
 * lifetime is the same as the Node process.
 */
const sourceMetaCache = makeSourceMetaCache();

/**
 * Fetch per-source icon metadata from the gateway. Cached for the
 * process lifetime — callers can invoke this once at command start
 * and reuse across many renders (e.g. inside a `status --watch`).
 * Never throws: on error returns {} so the CLI stays usable.
 */
export async function fetchSourceMeta(): Promise<SourceMeta> {
  return sourceMetaCache.get(() => gatewayFetch("/portal/source-meta.json"));
}

/** Test-only: drop the cached source-meta map. */
export function clearSourceMetaCache(): void {
  sourceMetaCache.clear();
}

/**
 * Build a one-shot `CliFx` context. Skips the meta fetch when the
 * terminal can't render images anyway — keeps commands fast on non-
 * supporting terminals and piped output. JSON mode forces everything off
 * so machine-readable output stays free of terminal control bytes.
 */
export async function buildCliFx(): Promise<CliFx> {
  return buildCliFxShared({ fetchMeta: fetchSourceMeta, disabled: isJSON });
}

// ── Spinner helper ─────────────────────────────────────────────────────
// `withSpinner` wraps a slow gateway-bound operation in a @clack/prompts
// timer spinner so the user sees something is happening while we wait on
// the gateway's IO queue. Three small choices worth knowing about:
//   - Output goes to stderr. Stdout stays clean for `| jq` etc.
//   - First paint is deferred 150ms — sub-150ms ops never flash a spinner.
//   - On settle: success/error frame with elapsed time (e.g. "◇ Loading [2s]").
//   - Disabled in JSON mode — JSON consumers shouldn't see incidental output
//     even on stderr they didn't ask for.
export async function withSpinner<T>(
  label: string,
  fn: (spin: SpinnerHandle) => Promise<T>,
): Promise<T> {
  return withSpinnerShared(label, fn, { disabled: isJSON });
}

// ---------------------------------------------------------------------------
// Path input with tab completion
// ---------------------------------------------------------------------------

/**
 * Prompt for a file path with tab completion.
 * Uses readline's built-in completer for directory/file tab completion.
 */
export function pathInput(opts: {
  message: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
  /** Resolve against this CLI host. Disable when the path belongs to a remote host. */
  resolvePath?: boolean;
  /** Absolute paths to exclude from tab completions (e.g. already-selected files) */
  excludePaths?: Set<string>;
  /** Pre-fill the input with this value (e.g. directory of previous file) */
  initialValue?: string;
  /**
   * Treat an empty answer as an answer rather than as a cancellation.
   *
   * An optional path is a real question with a meaningful blank: pressing
   * Enter means "you work it out". Without this the only way to express that
   * is to abandon the command.
   */
  allowEmpty?: boolean;
}): Promise<string | symbol> {
  const CANCEL = Symbol("cancel");

  return new Promise((res) => {
    let settled = false;
    // Print the prompt label in @clack style
    process.stdout.write(`${c.cyan}◆${c.reset}  ${opts.message}\n`);
    if (opts.placeholder) {
      process.stdout.write(`${c.dim}   ${opts.placeholder}${c.reset}\n`);
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: (line: string) => {
        // Local completions would be actively misleading for a path that is
        // owned by another collector's filesystem.
        if (opts.resolvePath === false) return [[], line];
        const home = process.env.HOME ?? "";
        const expanded = line.startsWith("~") ? home + line.slice(1) : line;

        // Determine the directory to list and the partial filename to match
        let dir: string;
        let partial: string;
        try {
          const stat = statSync(expanded);
          if (stat.isDirectory()) {
            dir = expanded;
            partial = "";
          } else {
            dir = dirname(expanded);
            partial = pathBasename(expanded);
          }
        } catch {
          dir = dirname(expanded);
          partial = pathBasename(expanded);
        }

        try {
          const entries = readdirSync(dir)
            .filter((e) => !partial || e.startsWith(partial))
            .map((e) => {
              const full = pathJoin(dir, e);
              try {
                return statSync(full).isDirectory() ? full + "/" : full;
              } catch {
                return full;
              }
            })
            .filter((full) => {
              // Exclude already-selected paths
              if (!opts.excludePaths?.size) return true;
              const cleanPath = full.endsWith("/") ? full.slice(0, -1) : full;
              return !opts.excludePaths.has(cleanPath);
            });

          // Preserve ~ prefix in completions
          if (line.startsWith("~")) {
            return [entries.map((e) => "~" + e.slice(home.length)), line];
          }
          return [entries, line];
        } catch {
          return [[], line];
        }
      },
    });

    const promptStr = `${c.gray}   │${c.reset} `;

    // Pre-fill input after the question prompt is shown (so cursor ends up at the end)
    if (opts.initialValue) {
      process.nextTick(() => rl.write(opts.initialValue!));
    }

    rl.question(promptStr, (answer) => {
      settled = true;
      rl.close();

      if (!answer) {
        process.stdout.write(`${c.gray}   └${c.reset}\n`);
        res(opts.allowEmpty ? "" : CANCEL);
        return;
      }

      // A remote collector must expand its own `~` and relative paths. Resolving
      // them here would silently substitute the operator host's filesystem.
      const home = process.env.HOME ?? "";
      const resolved =
        opts.resolvePath === false
          ? answer.trim()
          : answer.startsWith("~")
            ? home + answer.slice(1)
            : pathResolve(answer);

      // Validate
      if (opts.validate) {
        const error = opts.validate(resolved);
        if (error) {
          process.stdout.write(`${c.red}   ${error}${c.reset}\n`);
          // Retry — re-run pathInput instead of cancelling
          res(pathInput(opts));
          return;
        }
      }

      process.stdout.write(`${c.gray}   └${c.reset}\n`);
      res(resolved);
    });

    // Handle Ctrl+C
    rl.on("close", () => {
      if (!settled) {
        settled = true;
        res(CANCEL);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Gateway helpers for source management (descriptors, configured snapshot)
// ---------------------------------------------------------------------------

export interface ConfiguredSourcesSnapshot {
  /** The collector device that hosts these sources. */
  deviceId: string;
  /** Map of source-key → config flags. Keys are full source IDs (e.g. "gmail:user@gmail.com"). */
  configured: Record<string, { enabled: boolean; params?: Record<string, string> }>;
}

export interface DescriptorsSnapshot {
  deviceId: string;
  /** Page<SerializedDescriptor> shape; `items` replaced the legacy `descriptors`. */
  items: SerializedDescriptor[];
  pageInfo: { hasMore: boolean; limit: number; nextCursor?: string };
  /**
   * `os.hostname()` of the host running the collector — set when the
   * collector reports it (every gateway version that ships with this
   * field). Compare to `os.hostname()` here to decide whether the CLI is
   * running on the same host as the collector. Same host → safe to
   * auto-open a browser tab (the OAuth callback server lands on this
   * machine). Different host → render URLs only and let the user open
   * them themselves.
   */
  collectorHostname?: string;
}

/**
 * Fetch source descriptors hosted by the (resolved) collector device.
 * If multiple collectors are paired, the gateway returns a 400 with the list;
 * pass a deviceId to disambiguate.
 */
export async function fetchDescriptors(deviceId?: string): Promise<DescriptorsSnapshot> {
  const qs = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : "";
  return gatewayJson<DescriptorsSnapshot>(`/admin/sources/descriptors${qs}`);
}

/** Fetch what the collector currently has registered. */
export async function fetchSourcesSnapshot(deviceId?: string): Promise<ConfiguredSourcesSnapshot> {
  const qs = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : "";
  return gatewayJson<ConfiguredSourcesSnapshot>(`/admin/sources/snapshot${qs}`);
}

// ---------------------------------------------------------------------------
// Pattern resolution
// ---------------------------------------------------------------------------

/**
 * Resolve one or more patterns against a list of entries with id + providerId.
 * Thin wrapper around `resolveSourcePatterns` from `@omnesis/core` — kept
 * as a re-export so existing CLI callsites don't have to thread a new
 * import while the package surface is stabilizing.
 */
export function resolvePatterns(
  patterns: string[],
  entries: Array<{ id: string; providerId: string }>,
): string[] {
  return resolveSourcePatterns(patterns, entries);
}

/** Build entries from config source keys + descriptors for pattern resolution. */
export function configSourceEntries(
  sourceKeys: string[],
  descriptors: Array<{ id: string; provider: { id: string } }>,
): Array<{ id: string; providerId: string }> {
  return sourceKeys.map((key) => {
    const sourceType = sourceTypeOf(key);
    const desc = descriptors.find((d) => d.id === sourceType);
    return { id: key, providerId: desc?.provider.id ?? "" };
  });
}

/**
 * Interactive picker for selecting configured sources from a collector snapshot.
 */
export async function pickConfiguredSources(
  snapshot: ConfiguredSourcesSnapshot,
  message: string,
  filter?: (key: string, enabled: boolean) => boolean,
  noMatchMessage?: string,
): Promise<string[]> {
  const prompts = await import("@clack/prompts");
  const sources = snapshot.configured;

  const keys = Object.keys(sources).filter((k) => (filter ? filter(k, sources[k].enabled) : true));

  if (keys.length === 0) {
    console.log(`${c.yellow}${noMatchMessage ?? "No matching sources found."}${c.reset}`);
    // Empty match isn't an error — caller signals the no-op via the
    // returned empty list and exits 0 cleanly.
    return [];
  }

  const selected = await prompts.multiselect({
    message,
    options: keys.map((k) => ({
      value: k,
      label: `${k}${sources[k].enabled ? "" : ` ${c.dim}(paused)${c.reset}`}`,
    })),
    required: true,
  });

  if (prompts.isCancel(selected)) {
    prompts.cancel("Cancelled.");
    // User cancelled at the prompt (Esc / Ctrl-C inside clack). Surface
    // the same EXIT_CANCELLED that a SIGINT outside the prompt would
    // produce so script callers see one consistent code.
    throw new CliError("", EXIT_CANCELLED);
  }

  return selected as string[];
}
