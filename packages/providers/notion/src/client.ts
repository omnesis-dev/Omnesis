// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Client, APIResponseError, APIErrorCode, RequestTimeoutError } from "@notionhq/client";
import { createLogger, pMap, retry, type RetryOptions } from "@omnesis/core";
import type {
  BlockObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";

const log = createLogger("source:notion");

// ── Resilience knobs ───────────────────────────────────────────────
//
// Notion's API is occasionally slow on large databases (504s, multi-second
// queries), and rate-limited at ~3 req/s. The defaults below let the client
// survive those without failing entire sync cycles:
//
// - 120s per-request timeout (SDK default is 60s, too tight for big DBs).
// - 4 attempts total with 1s/2s/4s exponential backoff for transient errors.
// - 429 responses honor `Retry-After` if the header is present, else fall
//   through to exponential backoff.
//
// Permanent errors (404, 403, 401, 400) are NOT retried — they propagate on
// the first attempt so callers (e.g. `databases.ts:syncDbPhase`) can route
// them through their own logic (skip-and-continue, etc.).
const NOTION_REQUEST_TIMEOUT_MS = 120_000;
const NOTION_MAX_ATTEMPTS = 4;
const NOTION_BASE_BACKOFF_MS = 1_000;

/**
 * Concurrency for sibling block-tree fetches. Notion's published rate limit
 * is ~3 req/s; we cap at 2 in-flight to leave headroom for the global
 * search/list calls happening concurrently with the per-page block recursion.
 * 429s are still retried by `withRetry` if we trip the limit.
 */
const NOTION_BLOCK_TREE_CONCURRENCY = 2;

/**
 * Read `Retry-After` from a Notion error's headers. The SDK types `headers`
 * as `unknown` because the shape depends on the underlying fetch impl
 * (`Headers` instance with global fetch, plain object with custom fetches).
 * Returns milliseconds, or undefined if absent/unparseable.
 */
export function readRetryAfterMs(headers: unknown): number | undefined {
  let value: string | undefined;
  if (
    headers !== null &&
    typeof headers === "object" &&
    typeof (headers as { get?: unknown }).get === "function"
  ) {
    value = (headers as Headers).get("retry-after") ?? undefined;
  } else if (headers !== null && typeof headers === "object") {
    const rec = headers as Record<string, unknown>;
    const raw = rec["retry-after"] ?? rec["Retry-After"];
    if (typeof raw === "string") value = raw;
  }
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return undefined;
}

/** True if the error is one we should retry (timeout, 429, 5xx, network). */
export function isTransientNotionError(err: unknown): boolean {
  if (RequestTimeoutError.isRequestTimeoutError(err)) return true;
  if (APIResponseError.isAPIResponseError(err)) {
    if (err.code === APIErrorCode.RateLimited) return true;
    if (err.status >= 500 && err.status <= 599) return true;
    return false;
  }
  if (err instanceof Error) {
    // fetch / undici raises TypeError on network failures and AbortError on
    // signal timeout. The Notion SDK wraps the latter as RequestTimeoutError
    // already, but we keep the check for the bare-fetch path.
    if (err.name === "TypeError" || err.name === "AbortError" || err.name === "FetchError") {
      return true;
    }
  }
  return false;
}

export interface WithRetryOptions {
  sleepFn?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseBackoffMs?: number;
}

/**
 * Retry a Notion SDK call with exponential backoff for transient errors.
 * Thin Notion-flavoured wrapper over the canonical `retry` primitive in
 * `@omnesis/core` — provides the Notion-specific transient-error
 * predicate, Retry-After-aware backoff override, and the labelled log
 * line that callers use to identify which Notion call failed.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? NOTION_MAX_ATTEMPTS;
  const baseBackoffMs = opts.baseBackoffMs ?? NOTION_BASE_BACKOFF_MS;
  const retryOpts: RetryOptions = {
    maxAttempts,
    baseBackoffMs,
    sleep: opts.sleepFn,
    shouldRetry: (err) => isTransientNotionError(err),
    computeBackoff: (err, _attempt, defaultMs) => {
      if (APIResponseError.isAPIResponseError(err) && err.code === APIErrorCode.RateLimited) {
        const retryAfter = readRetryAfterMs(err.headers);
        if (retryAfter !== undefined) return retryAfter;
      }
      return defaultMs;
    },
    onRetry: (err, attempt, delayMs) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(
        `[${label}] transient error attempt ${attempt}/${maxAttempts}: ${errMsg} — retrying in ${delayMs}ms`,
      );
    },
  };
  return retry(fn, retryOpts);
}

// ── Helpers ────────────────────────────────────────────────────────

function richTextToMarkdown(richText: RichTextItemResponse[]): string {
  return richText
    .map((item) => {
      let text = item.plain_text;
      const { bold, italic, strikethrough, code } = item.annotations;
      if (code) text = `\`${text}\``;
      if (bold) text = `**${text}**`;
      if (italic) text = `*${text}*`;
      if (strikethrough) text = `~~${text}~~`;
      if (item.href) text = `[${text}](${item.href})`;
      return text;
    })
    .join("");
}

function getFileUrl(
  fileObj:
    | { type: "external"; external: { url: string } }
    | { type: "file"; file: { url: string; expiry_time: string } },
): string {
  return fileObj.type === "external" ? fileObj.external.url : fileObj.file.url;
}

function indent(text: string, depth: number): string {
  if (depth === 0) return text;
  const prefix = "  ".repeat(depth);
  return text
    .split("\n")
    .map((line) => (line ? prefix + line : line))
    .join("\n");
}

// ── Block Renderer ─────────────────────────────────────────────────

interface BlockWithChildren {
  block: BlockObjectResponse;
  children: BlockWithChildren[];
}

function renderBlock(node: BlockWithChildren, depth: number, linkedPageIds?: string[]): string {
  const { block, children } = node;

  switch (block.type) {
    case "paragraph": {
      const text = richTextToMarkdown(block.paragraph.rich_text);
      const childMd = renderChildren(children, depth, linkedPageIds);
      return indent(text, depth) + "\n" + childMd;
    }

    case "heading_1":
      return indent(`# ${richTextToMarkdown(block.heading_1.rich_text)}`, depth) + "\n";

    case "heading_2":
      return indent(`## ${richTextToMarkdown(block.heading_2.rich_text)}`, depth) + "\n";

    case "heading_3":
      return indent(`### ${richTextToMarkdown(block.heading_3.rich_text)}`, depth) + "\n";

    case "bulleted_list_item": {
      const text = richTextToMarkdown(block.bulleted_list_item.rich_text);
      const childMd = renderChildren(children, depth + 1);
      return indent(`- ${text}`, depth) + "\n" + childMd;
    }

    case "numbered_list_item": {
      const text = richTextToMarkdown(block.numbered_list_item.rich_text);
      const childMd = renderChildren(children, depth + 1);
      return indent(`1. ${text}`, depth) + "\n" + childMd;
    }

    case "to_do": {
      const checked = block.to_do.checked ? "x" : " ";
      const text = richTextToMarkdown(block.to_do.rich_text);
      const childMd = renderChildren(children, depth + 1);
      return indent(`- [${checked}] ${text}`, depth) + "\n" + childMd;
    }

    case "toggle": {
      const text = richTextToMarkdown(block.toggle.rich_text);
      const childMd = renderChildren(children, depth + 1);
      return indent(`> ${text}`, depth) + "\n" + childMd;
    }

    case "code": {
      const text = richTextToMarkdown(block.code.rich_text);
      const lang = block.code.language ?? "";
      return indent(`\`\`\`${lang}\n${text}\n\`\`\``, depth) + "\n";
    }

    case "quote": {
      const text = richTextToMarkdown(block.quote.rich_text);
      const childMd = renderChildren(children, depth, linkedPageIds);
      const quoted = text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return indent(quoted, depth) + "\n" + childMd;
    }

    case "callout": {
      const text = richTextToMarkdown(block.callout.rich_text);
      const childMd = renderChildren(children, depth, linkedPageIds);
      return indent(`> ${text}`, depth) + "\n" + childMd;
    }

    case "divider":
      return indent("---", depth) + "\n";

    case "image": {
      const url = getFileUrl(block.image);
      return indent(`![image](${url})`, depth) + "\n";
    }

    case "video": {
      const url = getFileUrl(block.video);
      return indent(`[video](${url})`, depth) + "\n";
    }

    case "file": {
      const url = getFileUrl(block.file);
      return indent(`[file](${url})`, depth) + "\n";
    }

    case "bookmark":
      return indent(`[bookmark](${block.bookmark.url})`, depth) + "\n";

    case "embed":
      return indent(`[embed](${block.embed.url})`, depth) + "\n";

    case "equation":
      return indent(`$$${block.equation.expression}$$`, depth) + "\n";

    case "table": {
      return renderTable(children, block.table.has_column_header, depth);
    }

    case "table_row":
      // Handled by table parent
      return "";

    case "child_page": {
      const childPageId = block.id.replace(/-/g, "");
      linkedPageIds?.push(`page-${childPageId}`);
      // No URL in markdown — intra-source links handle resolution via extra.links
      return indent(`[child page: ${block.child_page.title}]`, depth) + "\n";
    }

    case "child_database": {
      return indent(`[child database: ${block.child_database.title}]`, depth) + "\n";
    }

    case "link_to_page": {
      // link_to_page has page_id, database_id, or comment_id
      const ltp = block.link_to_page;
      const targetId =
        ltp.type === "page_id"
          ? ltp.page_id
          : ltp.type === "database_id"
            ? ltp.database_id
            : undefined;
      if (targetId) {
        linkedPageIds?.push(`page-${targetId.replace(/-/g, "")}`);
      }
      // No URL in markdown — intra-source links handle resolution via extra.links
      return indent("[link to page]", depth) + "\n";
    }

    case "synced_block":
      return renderChildren(children, depth, linkedPageIds);

    case "column_list":
    case "column":
      return renderChildren(children, depth, linkedPageIds);

    default:
      // breadcrumb, table_of_contents, template, audio, pdf, link_preview, unsupported
      return "";
  }
}

function renderChildren(
  children: BlockWithChildren[],
  depth: number,
  linkedPageIds?: string[],
): string {
  return children.map((child) => renderBlock(child, depth, linkedPageIds)).join("");
}

function renderTable(rows: BlockWithChildren[], hasColumnHeader: boolean, depth: number): string {
  const lines: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const block = rows[i].block;
    if (block.type !== "table_row") continue;

    const cells = block.table_row.cells.map((cell) => richTextToMarkdown(cell));
    lines.push(indent(`| ${cells.join(" | ")} |`, depth));

    if (i === 0 && hasColumnHeader) {
      const separator = cells.map(() => "---").join(" | ");
      lines.push(indent(`| ${separator} |`, depth));
    }
  }

  return lines.join("\n") + "\n";
}

// ── Client ─────────────────────────────────────────────────────────

export interface NotionClientOptions {
  /** Custom sleep — used by tests to advance time without real waiting. */
  sleepFn?: (ms: number) => Promise<void>;
}

export class NotionClient {
  private client: Client;
  private sleepFn: (ms: number) => Promise<void>;

  constructor(accessToken: string, opts: NotionClientOptions = {}) {
    this.client = new Client({
      auth: accessToken,
      timeoutMs: NOTION_REQUEST_TIMEOUT_MS,
    });
    this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return withRetry(label, fn, { sleepFn: this.sleepFn });
  }

  async searchPages(startCursor?: string) {
    return this.retry("searchPages", () =>
      this.client.search({
        filter: { property: "object", value: "page" },
        sort: { timestamp: "last_edited_time", direction: "descending" },
        page_size: 100,
        start_cursor: startCursor,
      }),
    );
  }

  async searchDatabases(startCursor?: string) {
    return this.retry("searchDatabases", () =>
      this.client.search({
        filter: { property: "object", value: "data_source" },
        sort: { timestamp: "last_edited_time", direction: "descending" },
        page_size: 100,
        start_cursor: startCursor,
      }),
    );
  }

  async getPageBlocks(blockId: string, startCursor?: string) {
    return this.retry("getPageBlocks", () =>
      this.client.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        start_cursor: startCursor,
      }),
    );
  }

  async getPageContent(pageId: string): Promise<{ markdown: string; linkedPageIds: string[] }> {
    const tree = await this.fetchBlockTree(pageId);
    const linkedPageIds: string[] = [];
    const markdown = renderChildren(tree, 0, linkedPageIds).trim();
    return { markdown, linkedPageIds };
  }

  async getDatabase(databaseId: string, dataSourceId?: string) {
    return this.retry("getDatabase", async () => {
      const resolvedDataSourceId =
        dataSourceId ?? (await this.resolvePrimaryDataSourceId(databaseId));
      return this.client.dataSources.retrieve({ data_source_id: resolvedDataSourceId });
    });
  }

  async queryDatabase(
    databaseId: string,
    startCursor?: string,
    lastEditedAfter?: string,
    dataSourceId?: string,
  ) {
    return this.retry("queryDatabase", async () => {
      const resolvedDataSourceId =
        dataSourceId ?? (await this.resolvePrimaryDataSourceId(databaseId));
      return this.client.dataSources.query({
        data_source_id: resolvedDataSourceId,
        page_size: 100,
        start_cursor: startCursor,
        filter: lastEditedAfter
          ? {
              timestamp: "last_edited_time",
              last_edited_time: { after: lastEditedAfter },
            }
          : undefined,
      });
    });
  }

  async listUsers() {
    return this.retry("listUsers", () => this.client.users.list({}));
  }

  // ── Private ────────────────────────────────────────────────────────

  private async resolvePrimaryDataSourceId(databaseId: string): Promise<string> {
    const database = await this.client.databases.retrieve({ database_id: databaseId });
    if ("data_sources" in database && database.data_sources[0]) {
      return database.data_sources[0].id;
    }
    return databaseId;
  }

  private async fetchBlockTree(blockId: string): Promise<BlockWithChildren[]> {
    const blocks = await this.fetchAllBlocks(blockId);
    // Fetch sibling subtrees in bounded parallel — sequential recursion
    // was N round-trips deep for an N-level page (cracking open every
    // toggled / nested block in series). Concurrency=2 keeps us under
    // Notion's ~3 req/s rate limit while cutting wall-clock dramatically
    // on pages with deep block trees. Order is preserved by `pMap`.
    return pMap(
      blocks,
      async (block) => {
        const children = block.has_children ? await this.fetchBlockTree(block.id) : [];
        return { block, children };
      },
      { concurrency: NOTION_BLOCK_TREE_CONCURRENCY },
    );
  }

  private async fetchAllBlocks(blockId: string): Promise<BlockObjectResponse[]> {
    const blocks: BlockObjectResponse[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.getPageBlocks(blockId, cursor);
      for (const result of response.results) {
        // The API can return PartialBlockObjectResponse (just id+object) — skip those
        if ("type" in result) {
          blocks.push(result as BlockObjectResponse);
        }
      }
      cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return blocks;
  }
}
