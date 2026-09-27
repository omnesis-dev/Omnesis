// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's Direct and Notes MCP tools, hosted as native harness tools.
 *
 * A connection's access level decides which of them it may use, and the
 * gateway's `tools/list` is the authority on that: it lists exactly the tools
 * the connection's credential is granted, with the descriptions and input
 * schemas the gateway serves every MCP client. The integration therefore keeps
 * no grant model of its own. It lists, offers what was listed, and forwards
 * each call to the same tool on the gateway.
 *
 * Answer is not forwarded. The harnesses host it through their own answer
 * tools, which own the waiting, approval routing and retry identity that a
 * plain forward would lose.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

import { writeSecretFileDurably } from "./credentials.js";
import type { IntegrationLogger } from "./logger.js";

/**
 * Every gateway tool an integration can host, in the order they are offered.
 *
 * A harness that declares its tools before it runs — OpenClaw names each one in
 * its plugin manifest — can only offer names it declared, so this is the
 * ceiling; the connection's listing decides what is actually offered. The
 * Hermes adapter states the same list, and `forwarded-tools-parity.test.ts`
 * holds both, and the manifests, to the gateway's own inventory.
 */
export const FORWARDED_TOOL_NAMES = [
  "search_many",
  "fetch_many",
  "lookup_document_by_url",
  "lookup_people",
  "trace_connections",
  "run_sql",
  "temporal_query",
  "entity_context",
  "search_loops",
  "list_loops",
  "fetch_loop",
  "list_tables",
  "add_note",
] as const;

export type ForwardedToolName = (typeof FORWARDED_TOOL_NAMES)[number];

const forwardedToolNames = new Set<string>(FORWARDED_TOOL_NAMES);

/** How long a forwarded call may take, above the gateway's own 30-second Direct limit. */
export const FORWARDED_TOOL_TIMEOUT_MS = 60_000;

/** How long a listing stands before the next use of the tools re-reads it. */
export const FORWARDED_TOOLS_STALE_MS = 5 * 60 * 1000;

/** How long to wait after a failed listing before trying again. */
export const FORWARDED_TOOLS_RETRY_MS = 60 * 1000;

const forwardedToolSchema = z.object({
  name: z.string().refine((name) => forwardedToolNames.has(name)),
  title: z.string().min(1).optional(),
  description: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()).refine((schema) => schema.type === "object"),
});

export type ForwardedTool = z.infer<typeof forwardedToolSchema> & { name: ForwardedToolName };

/** The connection a listing was made for: its gateway and its OAuth client. */
export interface ForwardedToolsOwner {
  gatewayUrl: string;
  clientId: string;
}

const cacheFileSchema = z.object({
  gatewayUrl: z.string(),
  clientId: z.string(),
  tools: z.array(z.unknown()),
});

/**
 * The hostable tools in a `tools/list` result, in offering order.
 *
 * A tool this integration cannot host, or one whose definition is malformed,
 * is left out rather than failing the whole listing: the rest of the grant is
 * still usable, and a harness offered a half-formed tool would hand the model
 * a schema it cannot satisfy.
 */
export function forwardedToolsFromListing(listing: readonly unknown[]): ForwardedTool[] {
  const byName = new Map<string, ForwardedTool>();
  for (const candidate of listing) {
    const parsed = forwardedToolSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const { name, title, description, inputSchema } = parsed.data;
    byName.set(name, {
      name: name as ForwardedToolName,
      ...(title ? { title } : {}),
      description,
      inputSchema,
    });
  }
  return FORWARDED_TOOL_NAMES.flatMap((name) => {
    const tool = byName.get(name);
    return tool ? [tool] : [];
  });
}

/** What one forwarded call returned, reduced to what a harness can show the model. */
export interface ForwardedToolOutcome {
  /** The gateway marked the result as a tool error: a refusal or a failed query. */
  isError: boolean;
  /** The gateway's text content, in order. */
  text: string;
  /** The gateway's structured result, when it sent one. */
  structuredContent?: unknown;
}

export function forwardedToolOutcome(result: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}): ForwardedToolOutcome {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .flatMap((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : [],
    )
    .join("\n");
  return {
    isError: result.isError === true,
    text,
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
  };
}

export interface ForwardedToolCatalogueOptions {
  /** One `tools/list` round trip for the connection's credential. */
  list(timeoutMs: number): Promise<readonly unknown[]>;
  /** Where the last listing is kept, so a restart with the gateway down keeps it. */
  cachePath: string;
  /**
   * Whose listing it is: the gateway and the OAuth client the listing was made
   * for. A kept listing made for anyone else — a connection since replaced by
   * `omnesis connect --refresh`, another gateway — is never offered. Without
   * one, no listing is kept or read.
   */
  owner: ForwardedToolsOwner | undefined;
  logger: IntegrationLogger;
  now?: () => number;
}

/**
 * The connection's forwardable tools, as the gateway last listed them.
 *
 * Read synchronously, because a harness decides a run's tools without waiting
 * on the network. A listing older than `FORWARDED_TOOLS_STALE_MS` is re-read in
 * the background on the next use, so a change to the connection's access
 * level reaches the harness within minutes and without a restart; so is one a
 * forwarded call found out of date. The last good listing is persisted for its
 * owner, and is what that owner's next process starts from until its own first
 * listing lands.
 */
export class ForwardedToolCatalogue {
  private tools: readonly ForwardedTool[];
  /** Whether the kept listing is this owner's copy of `tools`. */
  private kept: boolean;
  private nextRefreshAt = 0;
  private inFlight: Promise<void> | null = null;
  /** Bumped by `invalidate`, so a listing already under way cannot vouch for later access. */
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly options: ForwardedToolCatalogueOptions) {
    this.now = options.now ?? Date.now;
    const kept =
      options.owner === undefined ? null : readForwardedToolCache(options.cachePath, options.owner);
    this.tools = kept ?? [];
    this.kept = kept !== null;
  }

  /** The tools to offer now. A stale listing is re-read for the next caller. */
  current(): readonly ForwardedTool[] {
    if (this.now() >= this.nextRefreshAt) void this.refresh();
    return this.tools;
  }

  /**
   * Re-read the listing now. A listing already under way may have been
   * answered before the change that prompted this, so it is followed by
   * another rather than joined.
   */
  invalidate(): void {
    this.generation += 1;
    this.nextRefreshAt = 0;
    const pending = this.inFlight;
    if (pending) void pending.then(() => this.refresh());
    else void this.refresh();
  }

  /**
   * List the connection's tools once, joining a listing already under way.
   * Never rejects: a gateway that cannot be reached leaves the last listing in
   * place, which is the one the harness has been offering all along.
   */
  refresh(timeoutMs = FORWARDED_TOOL_TIMEOUT_MS): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const started = this.now();
    const generation = this.generation;
    this.nextRefreshAt = started + FORWARDED_TOOLS_RETRY_MS;
    this.inFlight = (async () => {
      let listed: ForwardedTool[];
      try {
        listed = forwardedToolsFromListing(await this.options.list(timeoutMs));
      } catch (error) {
        this.options.logger.warn(
          `could not list the Omnesis tools this connection may use: ${describe(error)}`,
        );
        return;
      }
      if (generation === this.generation) {
        this.nextRefreshAt = started + FORWARDED_TOOLS_STALE_MS;
      }
      const changed = JSON.stringify(listed) !== JSON.stringify(this.tools);
      this.tools = listed;
      const owner = this.options.owner;
      if (owner === undefined || (this.kept && !changed)) return;
      this.kept = false;
      try {
        writeSecretFileDurably(
          this.options.cachePath,
          `${JSON.stringify({ ...owner, tools: listed }, null, 2)}\n`,
        );
        this.kept = true;
      } catch (error) {
        this.options.logger.warn(`could not keep the Omnesis tool listing: ${describe(error)}`);
      }
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Settles once no listing is under way or queued behind one, for a clean shutdown. */
  async idle(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The listing a previous process kept for this owner, or null when there is
 * none: missing, unreadable, or kept for someone else.
 */
export function readForwardedToolCache(
  path: string,
  owner: ForwardedToolsOwner,
): ForwardedTool[] | null {
  try {
    const parsed = cacheFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (
      !parsed.success ||
      parsed.data.gatewayUrl !== owner.gatewayUrl ||
      parsed.data.clientId !== owner.clientId
    ) {
      return null;
    }
    return forwardedToolsFromListing(parsed.data.tools);
  } catch {
    return null;
  }
}

/** The owner of a connection's listing, once it has an OAuth client. */
export function forwardedToolsOwner(
  gatewayUrl: string,
  clientInformation: Readonly<Record<string, unknown>>,
): ForwardedToolsOwner | undefined {
  const clientId = clientInformation.client_id;
  return typeof clientId === "string" && clientId !== "" ? { gatewayUrl, clientId } : undefined;
}
