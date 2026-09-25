// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Type-aware document chunker.
 * Splits documents into embeddable chunks based on document type.
 */

import { deriveAuthor } from "@omnesis/core";
import { buildEmbeddingInput, buildEmbeddingPreamble } from "./embedding-input.js";
import type { Chunker, Chunk, IndexableDocument } from "./types.js";

const DEFAULT_CHUNK_SIZE = 2048; // ~512 tokens in chars
const DEFAULT_OVERLAP = 512; // ~128 tokens in chars

export function buildDocumentEmbeddingPreamble(doc: IndexableDocument): string {
  return buildEmbeddingPreamble({
    documentType: doc.metadata.documentType,
    title: doc.title,
    author: deriveAuthor(doc.metadata.people),
    sourceCreatedAt: doc.metadata.sourceCreatedAt,
  });
}

export class DocumentChunker implements Chunker {
  constructor(
    private chunkSize = DEFAULT_CHUNK_SIZE,
    private overlap = DEFAULT_OVERLAP,
  ) {}

  chunk(doc: IndexableDocument): Chunk[] {
    const type = doc.metadata.documentType ?? "unknown";
    const preamble = this.buildPreamble(doc);

    // Short documents: single chunk
    if (doc.content.length <= this.chunkSize) {
      return [
        {
          index: 0,
          text: doc.content,
          embeddingInput: buildEmbeddingInput(preamble, doc.content),
        },
      ];
    }

    let texts: string[];
    switch (type) {
      case "conversation":
        texts = this.splitConversation(doc.content);
        break;
      case "note":
      case "file":
      case "webpage":
      case "browsing-history":
        texts = this.splitMarkdown(doc.content);
        break;
      default:
        texts = this.splitParagraphs(doc.content);
        break;
    }

    return texts.map((text, i) => ({
      index: i,
      text,
      embeddingInput: buildEmbeddingInput(preamble, text),
    }));
  }

  private buildPreamble(doc: IndexableDocument): string {
    return buildDocumentEmbeddingPreamble(doc);
  }

  /**
   * Split by paragraphs (double newline), merging into target-size chunks.
   * Used for emails and general documents.
   */
  private splitParagraphs(content: string): string[] {
    const paragraphs = content.split(/\n\n+/);
    return this.mergeSegments(paragraphs);
  }

  /**
   * Split at markdown heading boundaries, then merge small sections.
   * Used for notes, files, and web pages.
   */
  private splitMarkdown(content: string): string[] {
    // Split at heading boundaries (keep heading with its content)
    const sections: string[] = [];
    const lines = content.split("\n");
    let current: string[] = [];

    for (const line of lines) {
      if (/^#{1,6}\s/.test(line) && current.length > 0) {
        sections.push(current.join("\n"));
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) {
      sections.push(current.join("\n"));
    }

    return this.mergeSegments(sections);
  }

  /**
   * Split conversations by message boundaries, keeping message groups together.
   * Messages typically start with a timestamp pattern like "[HH:MM]" or "**Name** (HH:MM)".
   */
  private splitConversation(content: string): string[] {
    // Split at message boundaries (lines starting with timestamp-like patterns)
    const msgPattern = /^(?:\[?\d{1,2}:\d{2}\]?|\*\*[^*]+\*\*\s*\()/;
    const lines = content.split("\n");
    const messages: string[] = [];
    let current: string[] = [];

    for (const line of lines) {
      if (msgPattern.test(line) && current.length > 0) {
        messages.push(current.join("\n"));
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) {
      messages.push(current.join("\n"));
    }

    // If no message boundaries found, fall back to paragraph split
    if (messages.length <= 1) {
      return this.splitParagraphs(content);
    }

    return this.mergeSegments(messages);
  }

  /**
   * Merge small segments into chunks of target size, with overlap.
   *
   * Hard-caps the output: no chunk is ever larger than `chunkSize`.
   * A single segment exceeding `chunkSize` (e.g. a browsing-history
   * hour group or a long markdown section) is sliced into `chunkSize`
   * char windows with `overlap` carry-over *before* the merge step.
   * Without this pre-split, oversize sections used to fall through as
   * single oversized chunks and get rejected by the embedder as
   * "Input is longer than the context size".
   */
  private mergeSegments(segments: string[]): string[] {
    if (segments.length === 0) return [];

    // Pre-split any oversize segment into chunkSize-bounded windows so
    // the merge loop's invariants hold (every `current` stays <= chunkSize).
    const normalized: string[] = [];
    for (const seg of segments) {
      if (seg.length > this.chunkSize) {
        normalized.push(...this.splitByChars(seg));
      } else {
        normalized.push(seg);
      }
    }

    const chunks: string[] = [];
    let current = "";
    let overlapBuffer: string[] = []; // recent segments for overlap

    for (const segment of normalized) {
      const candidate = current ? `${current}\n\n${segment}` : segment;

      if (candidate.length > this.chunkSize && current.length > 0) {
        chunks.push(current);

        // Start next chunk with overlap from recent segments — but only
        // if overlap + segment still fits in chunkSize. Otherwise an
        // "overlapped" chunk could itself exceed the cap.
        const overlapText = overlapBuffer.join("\n\n");
        const withOverlap = overlapText ? `${overlapText}\n\n${segment}` : segment;
        current =
          overlapText.length <= this.overlap && withOverlap.length <= this.chunkSize
            ? withOverlap
            : segment;
        overlapBuffer = [segment];
      } else {
        current = candidate;
        overlapBuffer.push(segment);
        // Keep overlap buffer trimmed
        while (overlapBuffer.length > 1 && overlapBuffer.join("\n\n").length > this.overlap) {
          overlapBuffer.shift();
        }
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks;
  }

  /**
   * Slice a single oversize segment into chunkSize-char windows with
   * `overlap` chars of carry-over between consecutive windows.
   */
  private splitByChars(text: string): string[] {
    const out: string[] = [];
    const step = Math.max(1, this.chunkSize - this.overlap);
    let pos = 0;
    while (pos < text.length) {
      out.push(text.slice(pos, pos + this.chunkSize));
      if (pos + this.chunkSize >= text.length) break;
      pos += step;
    }
    return out;
  }
}
