// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Compute a SHA-256 content hash for deduplication.
 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** How many links of a `cause` chain {@link toErrorMessage} will render. */
const MAX_ERROR_CAUSE_DEPTH = 5;

/**
 * The text a single error contributes, or `undefined` when it has nothing to
 * say. Falls back to `code` because the errors Node raises for a failed
 * connection routinely carry an empty message and put the diagnosis there;
 * a link with neither is a pure wrapper — an `AggregateError` around the
 * per-address failures, say — and contributing its class name would only
 * push noise between the caller's message and the real reason.
 */
function errorLabel(err: Error): string | undefined {
  const message = err.message.trim();
  if (message.length > 0) return message;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code.length > 0) return code;
  return undefined;
}

/**
 * The next error to read after `err`: its `cause`, or — for an
 * `AggregateError`, which carries its detail in `errors` and leaves `cause`
 * unset — the first of the failures it aggregates.
 */
function nextErrorCause(err: Error): Error | undefined {
  if (err.cause instanceof Error) return err.cause;
  if (err instanceof AggregateError) {
    return err.errors.find((entry: unknown): entry is Error => entry instanceof Error);
  }
  return undefined;
}

/**
 * Extract an error message from an unknown error value, following the `cause`
 * chain and joining each distinct link with `": "`.
 *
 * Reading only `err.message` is not enough for the errors that matter most.
 * `fetch()` rejects with a bare `TypeError: fetch failed` and puts the only
 * informative part — the DNS lookup, TLS handshake or socket failure that
 * actually happened — in `cause`; when every address a host resolved to
 * failed, that cause is an `AggregateError` whose own message is empty and
 * whose detail sits in `errors`. A caller that logs the top message alone
 * reports the category and drops the diagnosis, which is how an operator
 * ends up staring at `fetch failed` with no way to tell a name-resolution
 * outage from a connection reset.
 */
export function toErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const parts: string[] = [];
  const seen = new Set<Error>();
  let current: Error | undefined = err;

  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH && current !== undefined; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const label = errorLabel(current);
    // Skip a link whose text is already on the line. Wrappers across this
    // codebase name themselves *and* quote the failure they wrap, so a naive
    // join renders the reason twice ("check failed: socket closed: socket
    // closed"). Containment, not equality: the wrapper's text is longer than
    // the cause it quotes.
    if (label !== undefined && !parts.some((part) => part.includes(label))) parts.push(label);
    current = nextErrorCause(current);
  }

  // Every link was a silent wrapper: name the class rather than return "".
  if (parts.length === 0) return err.name;

  return parts.join(": ");
}

/**
 * Config directory for Omnesis.
 * Defaults to ~/.config/omnesis but can be overridden with OMNESIS_CONFIG_DIR.
 */
export const DEFAULT_CONFIG_DIR =
  process.env.OMNESIS_CONFIG_DIR ?? join(process.env.HOME ?? "~", ".config", "omnesis");

/**
 * The gateway's document store, inside its config directory. Its presence is
 * what makes a directory a corpus: `omnesis restore` refuses to overwrite one,
 * and `omnesis update` reads it to tell that this host runs a gateway.
 */
export const GATEWAY_STORE_FILE = "omnesis.db";

/** The gateway's search index, beside its document store. Rebuilds from it. */
export const GATEWAY_INDEX_STORE_FILE = "index.db";

/** The gateway's DuckDB analytics store. */
export const GATEWAY_ANALYTICS_STORE_FILE = "analytics.db";

/** The watch journal: the only copy of every watch's definition. */
export const WATCH_JOURNAL_FILENAME = "watch.db";

/** The operator's standing instructions to the agent, in the config directory. */
export const OPERATOR_INSTRUCTIONS_FILENAME = "OMNESIS.md";

/**
 * Compile-time exhaustiveness check for discriminated-union switches.
 *
 * Place at the unreachable default arm of a switch over an
 * **internal-discriminator** union. If a future variant is added to the
 * union and a switch site forgets to add the matching case, the new
 * variant flows into `assertNever` and TypeScript rejects the call —
 * the site fails to compile until the new case is handled.
 *
 *     function rank(p: Priority): number {
 *       switch (p) {
 *         case "user": return 0;
 *         case "realtime": return 1;
 *         case "background": return 2;
 *         default: return assertNever(p);
 *       }
 *     }
 *
 * Only use on **internal** unions where every variant is known at
 * compile time (worker message types, scheduler op classes, internal
 * enum-like states). For external-data switches — Notion property
 * types, WhatsApp message kinds, anything decoded from a third-party
 * payload — keep the default as a typed best-effort fallback so a new
 * upstream variant doesn't crash the gateway.
 *
 * Throws at runtime as defence-in-depth in case JS-side callers reach
 * here through type-erasure (e.g. JSON.parse output cast to a union).
 * The throw is never expected on TypeScript-typed call paths.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminator value: ${JSON.stringify(value as unknown)}`);
}

// ── Reasoning <think> tags ────────────────────────────────────────────────

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * Strip `<think>…</think>` reasoning spans from model output.
 *
 * Some OpenAI-compatible providers (Together, Fireworks, and other servers
 * hosting DeepSeek-R1 / Qwen-thinking models) emit the chain-of-thought
 * inline inside `message.content` wrapped in `<think>…</think>` rather than in
 * a separate `reasoning_content` field. Left in place it leaks into the agent
 * transcript and starves the query-expansion parser. This removes closed
 * spans and, if an opening tag was left unclosed (some servers omit the
 * close), drops everything from that tag onward. Use this for whole strings;
 * for an incremental SSE stream use {@link createThinkTagFilter}.
 */
export function stripThinkTags(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const openIdx = out.toLowerCase().indexOf(THINK_OPEN);
  if (openIdx !== -1) out = out.slice(0, openIdx);
  return out.trim();
}

/**
 * Longest k in [0, tag.length-1] such that the last k chars of `buf` equal the
 * first k chars of `tag` (case-insensitive). Used to hold back a trailing
 * fragment that might be the start of a tag split across stream chunks.
 */
function suffixIsTagPrefix(buf: string, tag: string): number {
  const max = Math.min(buf.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (buf.slice(buf.length - k).toLowerCase() === tag.slice(0, k).toLowerCase()) return k;
  }
  return 0;
}

/** Stateful filter over a token stream; see {@link createThinkTagFilter}. */
export interface ThinkTagFilter {
  /** Whether an opening `<think>` tag has been observed in this stream. */
  readonly sawThinking: boolean;
  /** Feed the next chunk; returns the visible (non-think) text to surface. */
  push(chunk: string): string;
  /** Call at stream end; returns any buffered non-think tail held back. */
  flush(): string;
}

/**
 * Streaming counterpart of {@link stripThinkTags}: suppresses `<think>…</think>`
 * spans across incremental chunks where a tag may be split between two SSE
 * deltas. It buffers only the minimal trailing fragment that could be the start
 * of a tag, so normal text flows through immediately. On {@link ThinkTagFilter.flush}
 * a held fragment that never became a tag is emitted; content still inside an
 * unclosed think block is dropped.
 */
export function createThinkTagFilter(): ThinkTagFilter {
  let inside = false;
  let sawThinking = false;
  let buf = "";
  return {
    get sawThinking(): boolean {
      return sawThinking;
    },
    push(chunk: string): string {
      buf += chunk;
      let out = "";
      for (;;) {
        if (!inside) {
          const idx = buf.toLowerCase().indexOf(THINK_OPEN);
          if (idx !== -1) {
            out += buf.slice(0, idx);
            buf = buf.slice(idx + THINK_OPEN.length);
            inside = true;
            sawThinking = true;
            continue;
          }
          const hold = suffixIsTagPrefix(buf, THINK_OPEN);
          out += buf.slice(0, buf.length - hold);
          buf = buf.slice(buf.length - hold);
          return out;
        }
        const idx = buf.toLowerCase().indexOf(THINK_CLOSE);
        if (idx !== -1) {
          buf = buf.slice(idx + THINK_CLOSE.length);
          inside = false;
          continue;
        }
        buf = buf.slice(buf.length - suffixIsTagPrefix(buf, THINK_CLOSE));
        return out;
      }
    },
    flush(): string {
      const out = inside ? "" : buf;
      buf = "";
      inside = false;
      return out;
    },
  };
}
