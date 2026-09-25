// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { silentIntegrationLogger, type IntegrationLogger } from "./logger.js";
import type { DurableIntegrationInbox } from "./inbox.js";

export interface AgentConversationMessage {
  id: string;
  harness: "openclaw" | "hermes";
  channel: string;
  chatId: string;
  chatName?: string;
  chatType?: string;
  role: "user" | "assistant";
  text: string;
  occurredAt: number;
}

export interface TranscriptPage {
  messages: AgentConversationMessage[];
  nextCursor: string;
  hasMore: boolean;
}

export interface TranscriptSource {
  readPage(cursor: string | null, signal: AbortSignal): Promise<TranscriptPage>;
}

export interface TranscriptSink {
  push(messages: AgentConversationMessage[], signal: AbortSignal): Promise<void>;
}

export interface DurableTranscriptIngestorOptions {
  stream: string;
  state: DurableIntegrationInbox;
  source: TranscriptSource;
  sink: TranscriptSink;
  intervalMs?: number;
  maxPagesPerSweep?: number;
  logger?: IntegrationLogger;
}

export class DurableTranscriptIngestor {
  private readonly opts: DurableTranscriptIngestorOptions;
  private readonly log: IntegrationLogger;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(options: DurableTranscriptIngestorOptions) {
    this.opts = options;
    this.log = options.logger ?? silentIntegrationLogger;
  }

  start(): void {
    if (this.loop) return;
    this.abort = new AbortController();
    this.loop = this.runLoop(this.abort.signal);
  }

  nudge(): void {
    this.wake?.();
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    this.wake?.();
    await this.loop;
    this.abort = null;
    this.loop = null;
    this.wake = null;
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<number> {
    let cursor = this.opts.state.getCursor(this.opts.stream);
    let uploaded = 0;
    const maxPages = this.opts.maxPagesPerSweep ?? 100;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = await this.opts.source.readPage(cursor, signal);
      if (page.nextCursor === cursor && page.hasMore) {
        throw new Error("transcript source returned a non-advancing cursor");
      }
      if (page.messages.length > 0) {
        await this.opts.sink.push(page.messages, signal);
        uploaded += page.messages.length;
      }
      // Advancing after a successful empty page is intentional: filtered
      // harness records are consumed even though nothing was uploaded.
      this.opts.state.setCursor(this.opts.stream, page.nextCursor);
      cursor = page.nextCursor;
      if (!page.hasMore) return uploaded;
    }
    throw new Error(`transcript sweep exceeded ${maxPages} pages`);
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce(signal);
      } catch (error) {
        if (!signal.aborted) {
          this.log.warn(
            `transcript ingestion failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (signal.aborted) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.opts.intervalMs ?? 20_000);
        this.wake = () => {
          clearTimeout(timer);
          this.wake = null;
          resolve();
        };
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            this.wake = null;
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}
